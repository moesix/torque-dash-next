# TorqueDashNext — System Architecture

This document describes the architecture of the Tier-2 modernization of
`torque-dash`. It covers the high-level topology, backend internals, frontend
internals, the synchronized-replay data flow, and the (currently conceptual)
containerisation topology.

---

## 1. High-Level Topology

Two clients talk to the same Express backend:

1. **Torque Pro** (Android) — pushes OBD2 frames to an unauthenticated,
   *email-gated* ingestion endpoint.
2. **Browser SPA** (React/Vite) — reads data over an authenticated, CORS +
    cookie-based session API (express-session + connect-pg-simple store).

```mermaid
flowchart LR
    TP[Torque Pro Android app] -->|GET /api/upload?eml=...| ING[Express: UploadController]
    BR[Browser SPA - React/Vite] -->|CORS + express-session /api/*| API[Express: /api router]

    ING --> UC[lib/userCache - email->user]
    ING --> IB[services/ingestBuffer]
    IB -->|Log.bulkCreate batched| DB[(PostgreSQL + TimescaleDB\nhypertable "Logs")]

    API --> SC[SessionController]
    API --> TC[TelemetryController.range]
    API --> USR[UserController]
    SC --> DB
    TC --> DB
    USR --> UDB[(PostgreSQL: Users/Sessions)]

    BR -.->|GET /api/sessions/:id/telemetry| TC
```

```
                          ┌─────────────────────────────────────────┐
   Torque Pro  ──GET────▶ │  Express (app.js)                        │
   /api/upload            │   ├─ UploadController.processUpload       │
   (email-gated +        │   │    ├─ lib/userCache (positive+neg)     │
    Bearer token req'd)  │   │    ├─ services/ingestBuffer           │──▶  PostgreSQL
                          │   │    │     └─ Log.bulkCreate (batched)  │      + TimescaleDB
   Browser SPA  ──/api──▶ │   │    └─ lib/ssrfGuard (forwardUrls)     │      hypertable Logs
    CORS + express-session  │   ├─ SessionController (list/metadata)    │
                          │   ├─ TelemetryController.range (paged)    │
                          │   └─ UserController (auth/forwardUrls)    │
                          └─────────────────────────────────────────┘
```

### Ingest path
`Torque Pro` → `GET /api/upload` → `UploadController.processUpload` →
resolve user (cached) → `findOrCreate` session (resolved numeric FK) →
`ingestBuffer.ingest()` → buffered `Log.bulkCreate` → `200 OK`.

`forwardUrls` fan-out is fire-and-forget (`setImmediate`), SSRF-guarded, native
`fetch` with a 3s `AbortController` timeout.

### Read path
`Browser SPA` → `CORS` + `express-session` → `/api/*` → `authenticate`
middleware → controller. Telemetry is served via
`GET /api/sessions/:id/telemetry?from&to&limit` (`TelemetryController.range`),
which enforces ownership (or `?shareId=` for shared sessions) and returns
**paged** frames from the `Logs` hypertable.

---

## 2. Backend Internals

### 2.1 `UploadController` (`controllers/UploadController.js`)
- **Email-gated:** resolves the `eml` query param to a `User` via
  `lib/userCache` (positive **and** negative TTL cache, 300s). Unknown emails
  get `403` and are **never buffered or forwarded**.
- **Resolved numeric FKs:** `Session.findOrCreate` caches `user.id` /
  `session.id`; only numeric FKs (plus the raw frame) are pushed into the buffer
  — never emails.
- **GPS:** `kff1005` = lon, `kff1006` = lat. Non-GPS uploads are stored with
  null lat/lon (no longer dropped).
- **Promoted columns:** `engineRpm` ← `values.kc` (PID 0x0C), `vehicleSpeed` ← `values.kd` (PID 0x0D). Torque stores hex keys **without leading zeros**, so the key is `kc`, not `k0c`. Values are extracted with a zero‑safe pattern: `values.kc != null ? Number(values.kc) : null` (preserves legitimate `0` values).
- **Auto-naming:** new sessions are automatically named `Trip DDMMYYYY HH:MM AM/PM` using the upload timestamp on first upload.
- **SSRF-guarded `forwardUrls`:** each URL is checked with `lib/ssrfGuard.isSafeUrl`
  before a fire-and-forget `fetch`.
- Responds `200 OK` immediately; the DB flush is asynchronous.

### 2.2 `ingestBuffer` (`services/ingestBuffer.js`)
- In-memory array flushed to `Log.bulkCreate(rows, { ignoreDuplicates: true })`
  when the buffer reaches `BATCH_SIZE = 1000` rows **or** every `FLUSH_MS = 1000`
  via an unref'd timer.
- Buffer stores only resolved numeric FKs + frame data.
- **Failure semantics:** a failed flush re-queues the batch (with an attempt
  counter) up to `MAX_RETRIES = 3`, after which rows are dropped and an error is
  logged. This bounds memory at the cost of possible telemetry loss on a
  persistently failing DB.
- ⚠️ See Known Issues (MEDIUM) — there is no flush mutex and the live buffer is
  not hard-capped between flushes.

### 2.3 `TelemetryController.range` (`controllers/TelemetryController.js`)
- `GET /api/sessions/:id/telemetry?from&to&limit[&shareId]`.
- Enforces ownership (`req.user.id`) or shared access (`?shareId=`).
- `Log.findAll` with `timestamp BETWEEN from AND to`, capped `limit`
  (`min(limit||5000, 10000)`), ordered ASC, **limited attributes**
  (`timestamp, lon, lat, values, engine_rpm, vehicle_speed`).
- Returns JSON frames (unlike the legacy `getOne`/`getAll` which eager-load
  the full `Log` array — see Known Issues, HIGH).

### 2.4 TimescaleDB (`infra/timescale/log_hypertable.sql`)
- **Hypertable** `Logs` partitioned by `timestamp` (`chunk_time_interval = 1 day`).
- **PK restructured** to `("sessionId", timestamp)` (required by TimescaleDB);
  `id` kept globally unique via a unique index for id-based `filter`/`cut`/`join`
  operations.
- **Promoted columns** `engine_rpm` (double precision) and `vehicle_speed`
  (double precision) for hot-path queries.
- **Index** `logs_session_time_idx ON "Logs"("sessionId", timestamp DESC)`.
- **Continuous aggregate** `log_1min` (1-minute buckets of avg/max rpm & speed,
  count) with a refresh policy. Currently **unused** by the API (Known Issues, LOW).

> Columns are **camelCase** (`sessionId`, `engine_rpm`) because no
> `underscore: true` is set; the SQL uses quoted identifiers accordingly.

---

## 3. Frontend Internals (`apps/frontend/`)

Stack: **React 18 + TypeScript + Vite + Tailwind v4 + Tremor + ECharts +
react-leaflet + TanStack Query + zustand**.

### 3.1 App structure
```
src/
  app/
    playbackStore.ts     # zustand: cursorTime, isPlaying, speed
    queryClient.ts       # TanStack Query client
    router.tsx           # routes: /login /register /sessions /sessions/:id
  components/
    charts/  OverlayChart.tsx, SessionSummaryCard.tsx, KpiCard.tsx, GaugeTile.tsx
    layout/  AppShell.tsx, MobileDrawer.tsx
    map/     GpsTrackMap.tsx
    tables/  SessionTable.tsx
    telemetry/ PidTogglePanel.tsx, DecodedMetricsTable.tsx
    ui/      Skeleton.tsx, ErrorAlert.tsx
  features/
    auth/    Login.tsx, Register.tsx, useAuth.ts
    dashboard/ ReplayDashboard.tsx, PlaybackControls.tsx
    sessions/  SessionBrowser.tsx
    settings/  SettingsPage.tsx
  lib/
    api.ts    # fetch wrapper, credentials:'include'
    types.ts
    pidDecode.ts   # PID auto-decode engine (pdDecode.ts)
    theme.ts   # dark/light mode detection, applyTheme, toggleTheme
```

### 3.2 Data fetching
- **TanStack Query** drives all reads: `getSessions`, `getSession`,
  `getTelemetry`.
- **Auth** is cookie-based: every `fetch` uses `credentials: 'include'`. The
  SPA expects **401 JSON** from protected endpoints and redirects to `/login`
  on 401 (unless already on an auth page).

### 3.3 Synchronized replay — `zustand` `playbackStore`
- `usePlaybackStore` holds `cursorTime` (epoch-ms), `isPlaying`, `speed`.
- Components subscribe **imperatively** (`usePlaybackStore.subscribe`) so moving
  the cursor does **not** re-render the React tree — critical because the
  **`<MapContainer>` must stay mounted**.

### 3.4 PID Decode Engine (`pidDecode.ts`)

The auto-discovery engine (`lib/pidDecode.ts`) extracts time-series data from
every frame's `values` JSONB bag using two sources of metadata:

- **Torque metadata keys** (`userFullName*`, `userShortName*`, `userUnit*`,
  `defaultUnit*`) — scanned from the frames themselves. Metadata keys use
  **two‑character PID suffixes** (e.g. `userFullName05`), so when a metadata
  lookup for a single‑character PID key like `k5` → suffix `"5"` fails, the
  engine retries with a leading‑zero padded suffix `"05"`.
- **Curated `FALLBACK_MAP`** — keys are in Torque's native format (hex **without**
  leading zeros, e.g. `k5`, `kc`, `kd`, `kf`, `kff1007`). No entries use
  `k05`/`k0c` etc.

The `getAvailableSeries()` function returns `SeriesSource[]` with resolved
display names and units (metadata > fallback > raw key), and `getSeriesData()`
extracts `[timestamp_ms, value]` pairs via the safe `coerceScalar()` helper.

> **Fix:** The `kff1007` fallback entry was relabelled to `"GPS Bearing"` / `°`
> to match Torque Pro's actual output for this PID (bearing in degrees, not
> coolant temperature). The short name and units now display correctly in the
> chart legend and decoded metrics table.

### 3.5 Session Summary Card (`SessionSummaryCard.tsx`)
- A combined card that replaces the previous 4-card grid (2 KpiCards + 2 GaugeTiles) in `ReplayDashboard`.
- Renders 3 live SVG ring gauges (RPM, Coolant, Speed) that update reactively as the playback cursor moves.
- Subscribes to `playbackStore.cursorTime` via imperative zustand subscription, matching the same pattern used by `GpsTrackMap` and `OverlayChart` markLine updates.
- Each gauge interpolates the nearest value from the session's telemetry frames based on the current cursor time.
> **Fix:** Hardcoded SVG stroke and fill colours were replaced with Tailwind
> `dark:` class variants (`dark:stroke-gray-700`, `dark:fill-gray-100`,
> `dark:fill-gray-400`) so gauge text, unit labels, and track rings remain
> visible when dark mode is active.

### 3.6 Multi-series Overlay Chart
- `OverlayChart.tsx` renders an ECharts instance with dynamic series: each
  selected metric source becomes a `type: 'line'` series on a shared time (x)
  axis within a **single** chart — replaces the old dual TimeSeriesChart layout.
- **Per-unit-group y-axes** — sources are grouped by their unit string (e.g.
  `rpm`, `km/h`, `°C`, `V`). Each unique unit gets a separate y-axis (left for
  the first group, right with offset for subsequent groups), letting you overlay
  RPM, speed, coolant temp, and O2 voltage without scale distortion. The total
  number of y-axes is capped at 4 (1 left + 3 right) sorted by frequency, and
  `rightMargin` is capped at 150px (reduced from 180px) to prevent axis labels
  from overflowing the chart container on displays with many selected metrics.
  The per-axis offset is 45px (down from 60px) to keep the chart area from
  squashing when 3+ right-side axes are visible.
- **Two separate effects** — data rebuild uses `notMerge: true` (replaces all
  series + yAxis config). Cursor markLine updates also use `notMerge: true`
  to prevent a React `removeChild` crash caused by ECharts modifying the DOM
  between renders. A single stable container div is always mounted (even when
  no metrics are selected) so the ECharts instance is never torn down and
  re-created.
- **No `torqueGroup` / `echarts.connect`** — the GPS map uses an imperative
  zustand subscription, so ECharts group sync is unnecessary. Hovering the chart
  fires `onCursorMove(tsMs)` on `updateAxisPointer`, which pushes the value into
  `playbackStore.setCursorTime`.
- **Large dataset handling** — `large: true` + LTTB sampling on each series.
  Data build uses pre-allocated arrays; a `safeMax` reduce loop replaces the old
  spread-into-`Math.max` pattern that threw `RangeError` at ~10k frames.
  The same `safeMax` + `coerceScalar` pattern is applied in `ReplayDashboard`
  for the KPI max-value calculations, fixing a bug where `maxRpm`/`maxSpeed`/
  `maxCoolant` could display as `0` when frame fields contained numeric strings
  or `null` values.
- **Metric selection** — `PidTogglePanel` renders available series grouped by
  heuristic category (Engine, Fuel & Air, Temperature, Electrical, Drivetrain,
  Other) with search filtering, color swatches matching the chart palette, and
  Select All / Clear / Reset buttons.
- **Decoded metrics table** — `DecodedMetricsTable` (collapsible) shows
  min/max/avg/last for every PID source, computed from pre-memoized series data
  (no frame re-scan on expand).

### 3.7 react-leaflet GPS track (imperative marker)
- `GpsTrackMap.tsx` mounts `<MapContainer>` **once** and never re-renders it on
  cursor changes.
- On `cursorTime` change, it finds the nearest frame via a **binary search**
  (`findNearestFrame`) over timestamps, then calls
  `marker.setLatLng([lat, lon])` **imperatively** — no React state, no map
  recreation.

### 3.8 Design System and Theme

- **CSS custom properties** — colors (bg-base, bg-card, text-primary, accent, etc.) defined as CSS variables in `index.css`, with `.dark` class overrides for dark mode. Tailwind v4 uses a CSS-first configuration approach: all design tokens are defined in the `@theme` block in `index.css`, referenced as `var()` tokens (`--color-surface-base`, `--color-fg`, `--color-brand-accent`). The `tailwind.config.ts` file is reduced to a minimal placeholder since the JS config is no longer the primary source of truth.
- **PostCSS replaced** — the `postcss.config.js` file has been removed. Tailwind is loaded via the `@tailwindcss/vite` Vite plugin (in `vite.config.ts`), with `@import "tailwindcss"` in `index.css` replacing the old `@tailwind base/components/utilities` directives.
- **Tremor v3 compatibility** — Tremor v3 uses class names like `bg-tremor-brand-emphasis` or `rounded-tremor-default` that Tailwind v4 does not detect by default from `node_modules`. These are safelisted via `@source inline()` pattern directives in `index.css`, which replace the v3 `safelist: [{pattern: /.../}]` JS config approach. The Tremor `node_modules` directory is also scanned with `@source "../node_modules/@tremor/react/dist/**/*.{js,ts,jsx,tsx}"` so any Tremor classes found in source are picked up automatically.
- **Typography** — Google Fonts: Space Grotesk for display/body text, Martian Mono for monospace data. Font stacks are exposed as `--font-display`, `--font-body`, `--font-mono` CSS variables and mapped to Tailwind theme values (`--font-display`, `--font-body`, `--font-mono`) in the `@theme` block.
- **Dark mode** — managed by `lib/theme.ts`: detects `prefers-color-scheme`, persists choice to localStorage, provides `getTheme()` / `setTheme()` / `toggleTheme()`. The theme toggle button (sun/moon icons) lives in `AppShell` and applies the `.dark` class on `<html>`. The custom variant `@custom-variant dark (&:where(.dark, .dark *));` in `index.css` enables `dark:` class-based Tailwind variants.
- **Mobile drawer** — `MobileDrawer.tsx` renders a slide-out navigation panel with backdrop overlay, Escape-to-close, focus-on-open, and dark mode support. Triggered by a hamburger button visible below the `md` breakpoint.
- **Loading skeletons** — `Skeleton.tsx` provides a shimmer-animated placeholder for async content; `ErrorAlert.tsx` renders a dismissible error banner. Both replace raw text placeholders in `SessionBrowser` and `ReplayDashboard`.
- **Micro-interactions** — fadeIn/slideUp CSS animations with staggered delays (4 tiers) on dashboard sections; page transitions via `<Outlet key={location.pathname}>`; card-hover effects on table rows. All animations opt out when `prefers-reduced-motion: reduce` is set.

### 3.9 UI Refinement & Teal Branding (2026-07-17)

The following modern CSS and UX enhancements were applied in the UI refinement pass:

- **Brand color shift** — Primary accent changed from amber (`#f59e0b`) to teal (`#009999` light / `#2ec4b6` dark). Tremor brand tokens, chart series colors (COLORS[0]), map polylines, gauge rings, sidebar logos, login/register panels, focus rings, and `accent-color` all use the teal palette.
- **`light-dark()` CSS function** — All color tokens (`--bg-base`, `--text-primary`, `--accent`, `--border-default`, etc.) are defined once in `:root` using `light-dark(lightValue, darkValue)`. This eliminates the need to redeclare every variable in `.dark {}`. The `.dark` class block is retained as a fallback for browsers that don't support `light-dark()` yet.
- **`color-scheme` declaration** — `color-scheme: light dark` in CSS + `<meta name="color-scheme" content="light dark">` in `index.html`. Browser UI (scrollbars, form controls) automatically adapts to the system theme.
- **`accent-color: var(--accent)`** — Checkboxes, radio buttons, range sliders, and other native form controls inherit the teal brand color.
- **Custom scrollbar theming** — `scrollbar-color` + `scrollbar-width` set via CSS custom properties with `light-dark()` values, so scrollbars match the active theme.
- **Fluid typography** — `--text-tremor-title: clamp(1rem, 1.5cqi, 1.125rem)` and `--text-tremor-metric: clamp(1.5rem, 2cqi, 1.875rem)` for responsive font sizing that scales with the container.
- **Native `<dialog>` for fullscreen chart** — The expanded chart overlay in `ReplayDashboard` uses `<dialog closedby="any">` with `showModal()`/`close()` for proper modal behavior (focus trapping, Escape key, light-dismiss). Safari fallback adds a click-outside handler for browsers without `closedby` support.
- **Scroll-driven animations** — Dashboard session cards use `animation-timeline: view()` with `animation-range` for entry reveals as cards scroll into the viewport, without JavaScript scroll listeners.
- **View Transitions API** — Crossfade page navigation via `::view-transition-old(root)` and `::view-transition-new(root)` keyframe animations. The main content area carries `viewTransitionName: 'main-content'` in AppShell.
- **`scrollbar-gutter: stable`** — Applied to `.scrollable-area` to prevent layout shift when scrollbars appear/disappear.
- **`text-wrap: balance`** — Applied to all headings (`h1`–`h4`) for visually balanced line breaks.
- **`overscroll-behavior: contain`** — Prevents scroll chain/elastic overscroll on scrollable containers.
- **Card hover polish** — `.card-hover` now uses `translate: 0 -2px` on hover for a subtle lift effect, plus `box-shadow` transition.
- **Sidebar depth** — AppShell sidebar uses layered `box-shadow` for subtle inset depth (1px border + 4px shadow).
- **Reduced motion** — All new animations (scroll-driven, view transitions, card hover) are gated behind `prefers-reduced-motion: reduce` which sets `animation: none !important` and `transition: none !important`.

---

## 4. Synchronized Replay Data Flow

```
User hovers overlay chart
   │  (ECharts updateAxisPointer → onCursorMove(tsMs))
   ▼
OverlayChart → setCursorTime(tsMs)               [zustand playbackStore]
   │
   ├── react-leaflet GpsTrackMap (subscribe)      [imperative, outside React render]
   │        │  findNearestFrame(frames, cursorTime)  (binary search)
   │        ▼
   │   marker.setLatLng([lat, lon])
   │
   └── OverlayChart (markLine merge effect)       [merge mode, no re-render]
            │  updates cursor vertical line position
            ▼
       cursorTime applied without full data rebuild
```

The single source of truth is `cursorTime` in the zustand store. The overlay
chart's cursor markLine (updated via ECharts merge mode, `notMerge: false`) and
the map marker (set imperatively outside React render) react to it without
re-rendering the component tree.

Unlike the previous dual-chart layout — which used `echarts.connect('torqueGroup')`
to sync axis pointers across separate RPM and Speed charts — the current overlay
chart renders all selected series in a single ECharts instance. Cross-chart sync
is unnecessary.

---

## 5. Containerisation Topology (conceptual)

The intended production topology is three services on an internal network:

```
┌────────────┐     ┌──────────────────┐     ┌──────────────────────────┐
│  db        │◀────│  backend (Express)│◀────│  frontend / nginx        │
│ PostgreSQL +│     │  :3000           │     │  serves SPA build,        │
│ TimescaleDB │     │  /api + /api/upload│   │  proxies /api -> backend  │
└────────────┘     └──────────────────┘     └──────────────────────────┘
   internal net        internal net              edge / public
```

- **db** — PostgreSQL with the TimescaleDB extension; migrated via
  `scripts/migrate.js`.
- **backend** — Express on `:3000`; CORS allowlist + `sameSite:none; secure`
  cookie for cross-origin SPA auth; `/health` probe.
- **frontend / nginx** — serves the `apps/frontend/dist` build (or a CDN) and
  proxies `/api` to the backend; public edge.

Each service should expose a healthcheck (backend: `GET /health`).

> ⚠️ **Status:** This container topology is **documented/scaffolded, not yet a
> committed compose file.** No `docker-compose.yml` (or Kubernetes manifests)
> currently exists in the repo — only `infra/timescale/log_hypertable.sql`.
> The deploy topology (separate SPA origin/CDN vs. same-origin nginx) is still
> to be finalized; see Known Issues (LOW) regarding Express not serving the SPA
> build today.

---

## 6. API Contract (backend ↔ frontend)

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/users/register` | none | register |
| `POST /api/users/login` | none | login (sets cookie) |
| `POST /api/users/change-password` | cookie | change password (requires currentPassword + newPassword; regenerates session) |
| `GET /api/users/logout` | cookie | logout |
| `GET /api/sessions` | cookie | list sessions (summary) |
| `GET /api/sessions/:id` | cookie + owner | session metadata (no full logs) |
| `GET /api/sessions/:id/telemetry?from&to&limit` | cookie + owner | paged telemetry frames |
| `PATCH /api/sessions/:id` | cookie + owner | rename session (body: `{ name }`) |
| `GET /api/sessions/:id/shared/:shareId` | shareId | shared view |
| `GET /api/settings` | none | public settings (disableRegistration, hasUploadApiToken) |
| `PUT /api/settings` | cookie | update settings (disableRegistration, uploadApiToken) |
| `POST /api/settings/upload-token` | cookie | generate a new upload API token (shown once) |
| `POST /api/upload` (`/upload` from Torque) | email-gated + **Bearer token required when `UPLOAD_API_TOKEN` is set** | ingest (401 without token) |
| `GET /health` | none | probe |

> See `routes/api.js` for the authoritative route table. The SPA auth contract
> is now **resolved** — all endpoints return JSON/401 over `/api`. See
> `docs/development.md → Known Issues` for history.
