# torqueDASH-Next

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="torqueDASH-Next — Self-hosted OBD-II telemetry dashboard">
</p>

<p align="center">
  <img src="./imgs/dashboard.jpg" width="100%" alt="torqueDASH-Next dashboard showing route map with color-coded speed and telemetry chart">
</p>

## What is torqueDASH-Next?

A self-hosted dashboard for [Torque Pro](https://torque-bhp.com/) vehicle telemetry. Torque Pro streams live OBD-II data from your car over HTTPS; torqueDASH-Next stores it in a time-series database and renders it in a React dashboard — live gauges, a route map, session replays, and per-session summaries. All data stays on your own server.

## Quick start

```bash
# Download the production files
curl -O https://raw.githubusercontent.com/moesix/torque-dash-next/master/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/moesix/torque-dash-next/master/.env.example

# Create your .env and edit with your settings
cp .env.example .env
nano .env

# Start the stack
docker compose -f docker-compose.prod.yml up -d
```

Then open **http://localhost:8080**.

### Required configuration

The app **will not start** without `DATABASE_URL` and `SESSION_KEYS`.

| Variable | Description | How to generate |
|----------|-------------|-----------------|
| `DATABASE_URL` | PostgreSQL/TimescaleDB connection string (REQUIRED) | `postgres://user:password@host:5432/torquedash` |
| `POSTGRES_PASSWORD` | Database password for Docker deployments (REQUIRED) | `openssl rand -base64 24` |
| `SESSION_KEYS` | Express session secrets (REQUIRED) | `openssl rand -hex 24` |
| `UPLOAD_API_TOKEN` | Bearer token for Torque Pro — **required when configured** | `openssl rand -hex 24` or generate in Settings UI |
| `COOKIE_SECURE` | Set to `true` behind HTTPS | — |

### Connect Torque Pro

In Torque Pro → *Settings → Web Preferences*:
- **Server URL:** `https://<your-host>/api/upload`
- **Email address:** the email you registered with
- **Broadcast as HTTP** with header: `Authorization: bearer <UPLOAD_API_TOKEN>`

After creating all user accounts, disable public registration via the Settings UI or set `DISABLE_REGISTRATION=true` in your `.env` file.

## Features

- **Docker-first deployment** — one `docker compose up` and you're running.
- **Time-series storage** — TimescaleDB hypertable + continuous aggregate for fast
  per-session queries over large log volumes.
- **React dashboard** — live vehicle view, route map (OpenStreetMap tiles, no API key), replay with a multi-series PID overlay chart (toggleable metric panel, collapsible stats table, y-axis capped at 4 axes total to prevent overcrowding), a session summary card with live SVG ring gauges (RPM, Coolant, Speed) that update as the playback cursor moves, and a settings page with upload API token management. Full dark mode support, mobile-responsive layout with a slide-out navigation drawer, and loading skeletons throughout.
- **Session auto-naming** — new sessions are automatically named `Trip DDMMYYYY HH:MM AM/PM` on first upload.
- **Inline session rename** — rename sessions directly from the session table via an inline edit button (pencil icon, Enter/Escape/blur handling).
- **PID decode engine** — auto-discovers all OBD-II parameters from Torque's JSONB `values` column using embedded metadata (`userFullName*`/`userUnit*`) and a curated fallback map; no schema changes needed for new PIDs. Torque stores OBD‑II PIDs as hex keys without leading zeros (e.g. `kc` for RPM/PID 0x0C, `kd` for Speed/PID 0x0D).
- **Controlled ingestion** — email-gated uploads with an optional API-token
  (`Bearer`) authentication for Torque Pro over HTTPS; token can be generated from
  the Settings UI or set via the `UPLOAD_API_TOKEN` environment variable. When set,
  uploads require both a valid email address AND the bearer token for authentication.
- **Operational guards** — rate-limited upload endpoint, togglable open
  registration, and environment-driven configuration.
- **Design system** — Teal brand color (`#009999` light / `#2ec4b6` dark) with CSS custom properties using `light-dark()` for automatic theme-aware color tokens; fluid typography via `clamp()` (Tremor title/metric sizes); `color-scheme: light dark` with `.dark` class fallback for broad browser support; Google Fonts (Space Grotesk + Martian Mono); Tailwind v4 configured via CSS-first `@theme` block (custom font-family stacks, semantic color tokens, and Tremor design tokens all in `index.css`); PostCSS replaced by the `@tailwindcss/vite` plugin.
- **Dark mode** — system preference detection with manual override, persisted to localStorage, toggled via a sun/moon button in the app header. Color tokens use the `light-dark()` CSS function for automatic theme switching, with `.dark` class overrides as fallback. `accent-color: var(--accent)` applies the teal brand to form controls (checkboxes, radios, sliders). Custom scrollbar theming via `scrollbar-color` with `light-dark()` values. All components carry `dark:` Tailwind variants (class-based toggling via `@custom-variant dark` in `index.css`).
- **Mobile responsive** — responsive layout with a hamburger-triggered slide-out drawer (MobileDrawer), touch-friendly 44px minimum tap targets, and fluid chart sizing that adapts to viewport width.
- **Accessibility** — focus-visible indicators, skip-to-content link, form validation with aria-invalid/aria-describedby, keyboard navigation on interactive elements, and aria-live regions for dynamic content.
- **Micro-interactions** — fade-in/slide-up page transitions keyed on the active route, staggered reveal with animation-delay on dashboard sections, card-hover effects on table rows. Scroll-driven `view()` animations for session card reveals as they enter the viewport. View Transitions API (`::view-transition-old/new(root)`) for smooth crossfade page navigation. Native `<dialog>` element with `closedby="any"` for the fullscreen expanded chart (light-dismiss on backdrop click or Escape). Respects `prefers-reduced-motion`.

## Architecture

| Layer     | Stack                                                        |
|-----------|-------------------------------------------------------------|
| Backend   | Node.js + Express 4, Sequelize 6, PostgreSQL / TimescaleDB |
| Frontend  | React 18 + Vite + TypeScript, ECharts, Leaflet, pidDecode  |
| Deploy    | Docker Compose: `db` (TimescaleDB) + `backend` + `frontend` (nginx) |

## Configuration

<details>
<summary>Full environment variables reference</summary>

| Variable                   | Default                                  | Description                                                                 |
|----------------------------|------------------------------------------|-----------------------------------------------------------------------------|
| `DATABASE_URL`            | **REQUIRED** — no default                | PostgreSQL/TimescaleDB connection string. App crashes on startup if missing. |
| `PORT`                    | `3000`                                  | Backend HTTP port.                                                          |
| `NODE_ENV`                | _(unset)_                               | Set to `production` to skip `sequelize.sync()` (use migrations instead).    |
| `SESSION_KEYS`            | **REQUIRED** — no default                | Comma-separated express-session secrets (array). App crashes on startup if missing. Generate with `openssl rand -hex 24`. |
| `COOKIE_SECURE`           | `false`                                 | `true` to set `Secure` on session cookies (requires HTTPS).                 |
| `COOKIE_SAMESITE`         | `lax`                                   | `SameSite` policy for session cookies.                                      |
| `CORS_ORIGINS`           | _(empty = same-origin only)_            | Comma-separated allowed origins for cross-origin API access. Also serves as the CSRF trust list — state-changing requests from any other origin are rejected (see `middleware/csrfGuard.js`). Entries must exactly match the browser `Origin` (correct scheme, no trailing slash). For local dev, use a consistent hostname for the API and SPA (e.g. both `localhost`) to avoid spurious 403s. |
| `PUBLIC_ORIGIN`           | _(unset)_                               | Overrides the expected CSRF origin. Set to the browser-visible origin (e.g. `https://app.example.com`) when nginx terminates HTTPS but forwards HTTP to the backend. |
| `UPLOAD_RATE_LIMIT_MAX`    | `600`                                   | Max uploads per `UPLOAD_RATE_LIMIT_WINDOW_MS` per IP.                       |
| `UPLOAD_RATE_LIMIT_WINDOW_MS` | `60000`                             | Upload rate-limit window in milliseconds.                                   |
| `UPLOAD_API_TOKEN`        | _(unset)_                               | If set, uploads **REQUIRE** `Authorization: Bearer <token>` — without it, uploads return 401. This is a security gate: email alone is no longer sufficient. Can also be generated from the Settings UI (UI token takes precedence). |
| `AUTH_RATE_LIMIT_MAX`     | `10`                                    | Max login/register requests per window per IP.                              |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `60000`                               | Auth rate-limit window in milliseconds.                                     |
| `WRITE_RATE_LIMIT_MAX`    | `30`                                    | Max authenticated mutations (PUT settings/forwardurls) per window per IP.   |
| `WRITE_RATE_LIMIT_WINDOW_MS` | `60000`                              | Write rate-limit window in milliseconds.                                    |
| `READ_RATE_LIMIT_MAX`     | `600`                                   | Max requests to all other `/api` routes per window per IP (generous — the SPA polls telemetry during replay). |
| `READ_RATE_LIMIT_WINDOW_MS` | `60000`                               | Global `/api` rate-limit window in milliseconds.                            |
| `DISABLE_REGISTRATION`    | _(unset)_                               | If `true`, public sign-up is disabled (admin can still create accounts).    |

</details>

## Security

**Upload authentication:** When `UPLOAD_API_TOKEN` is set, all uploads must include the `Authorization: Bearer <token>` header. Email alone is no longer sufficient — this closes a gap where a valid email could inject data. If you're upgrading, add your token in Torque Pro → *Settings → Advanced → HTTP Auth Token*. Configurable from the Settings UI or via the environment variable.

**Password changes:** Authenticated users can change their password via `POST /api/users/change-password` with `{ "currentPassword": "...", "newPassword": "..." }`. This validates the current password, enforces a minimum length of 8 characters, and invalidates all other sessions for the user. Bcrypt salt factor is set to 10 (OWASP minimum).

**Registration control:** After creating user accounts, disable public sign-up via the Settings UI toggle or the `DISABLE_REGISTRATION=true` environment variable.

## License

MIT — see [LICENSE](./LICENSE). This project is a modernization of, and is grateful for, the original [torque-dash](https://github.com/davekrejci/torque-dash) by David Krejci. Attribution is recorded in [NOTICE](./NOTICE).
