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
   (email-gated,         │   │    ├─ lib/userCache (positive+neg)    │
    no auth)             │   │    ├─ services/ingestBuffer           │──▶  PostgreSQL
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
- **Promoted columns:** `engineRpm` ← `values.k4`, `vehicleSpeed` ← `values.k5`.
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

Stack: **React 18 + TypeScript + Vite + Tailwind + Tremor + ECharts +
react-leaflet + TanStack Query + zustand**.

### 3.1 App structure
```
src/
  app/
    playbackStore.ts     # zustand: cursorTime, isPlaying, speed
    queryClient.ts       # TanStack Query client
    router.tsx           # routes: /login /register /sessions /sessions/:id
  components/
    charts/  OverlayChart.tsx, KpiCard.tsx, GaugeTile.tsx
    layout/  AppShell.tsx
    map/     GpsTrackMap.tsx
    tables/  SessionTable.tsx
    telemetry/ PidTogglePanel.tsx, DecodedMetricsTable.tsx
  features/
    auth/    Login.tsx, Register.tsx, useAuth.ts
    dashboard/ ReplayDashboard.tsx, PlaybackControls.tsx
    sessions/  SessionBrowser.tsx
    settings/  SettingsPage.tsx
  lib/
    api.ts    # fetch wrapper, credentials:'include'
    types.ts
    pidDecode.ts   # PID auto-decode engine (pdDecode.ts)
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

### 3.4 Multi-series Overlay Chart
- `OverlayChart.tsx` renders an ECharts instance with dynamic series: each
  selected metric source becomes a `type: 'line'` series on a shared time (x)
  axis within a **single** chart — replaces the old dual TimeSeriesChart layout.
- **Per-unit-group y-axes** — sources are grouped by their unit string (e.g.
  `rpm`, `km/h`, `°C`, `V`). Each unique unit gets a separate y-axis (left for
  the first group, right with offset for subsequent groups), letting you overlay
  RPM, speed, coolant temp, and O2 voltage without scale distortion.
- **Two separate effects** — data rebuild uses `notMerge: true` (replaces all
  series + yAxis config); cursor markLine updates use `notMerge: false` (merge
  mode) so a hover never re-renders the full dataset.
- **No `torqueGroup` / `echarts.connect`** — the GPS map uses an imperative
  zustand subscription, so ECharts group sync is unnecessary. Hovering the chart
  fires `onCursorMove(tsMs)` on `updateAxisPointer`, which pushes the value into
  `playbackStore.setCursorTime`.
- **Large dataset handling** — `large: true` + LTTB sampling on each series.
  Data build uses pre-allocated arrays; a `safeMax` reduce loop replaces the old
  spread-into-`Math.max` pattern that threw `RangeError` at ~10k frames.
- **Metric selection** — `PidTogglePanel` renders available series grouped by
  heuristic category (Engine, Fuel & Air, Temperature, Electrical, Drivetrain,
  Other) with search filtering, color swatches matching the chart palette, and
  Select All / Clear / Reset buttons.
- **Decoded metrics table** — `DecodedMetricsTable` (collapsible) shows
  min/max/avg/last for every PID source, computed from pre-memoized series data
  (no frame re-scan on expand).

### 3.5 react-leaflet GPS track (imperative marker)
- `GpsTrackMap.tsx` mounts `<MapContainer>` **once** and never re-renders it on
  cursor changes.
- On `cursorTime` change, it finds the nearest frame via a **binary search**
  (`findNearestFrame`) over timestamps, then calls
  `marker.setLatLng([lat, lon])` **imperatively** — no React state, no map
  recreation.

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
| `GET /api/users/logout` | cookie | logout |
| `GET /api/sessions` | cookie | list sessions (summary) |
| `GET /api/sessions/:id` | cookie + owner | session metadata (no full logs) |
| `GET /api/sessions/:id/telemetry?from&to&limit` | cookie + owner | paged telemetry frames |
| `GET /api/sessions/:id/shared/:shareId` | shareId | shared view |
| `GET /api/settings` | none | public settings (disableRegistration, hasUploadApiToken) |
| `PUT /api/settings` | cookie | update settings (disableRegistration, uploadApiToken) |
| `POST /api/settings/upload-token` | cookie | generate a new upload API token (shown once) |
| `POST /api/upload` (`/upload` from Torque) | none (email-gated) | ingest |
| `GET /health` | none | probe |

> See `routes/api.js` for the authoritative route table. The SPA auth contract
> is now **resolved** — all endpoints return JSON/401 over `/api`. See
> `docs/development.md → Known Issues` for history.
