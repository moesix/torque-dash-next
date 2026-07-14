# torque-dash-next

A modern, self-hostable dashboard for [Torque Pro](https://torque-bhp.com/) vehicle telemetry.

> This project is a **modernisation of the original developer's work**,
> [torque-dash](https://github.com/davekrejci/torque-dash) by **David Krejci**
> (MIT licensed). The original project is **not** archived — this repository simply
> carries the idea forward on a newer stack. All credit and attribution belong to
> the original author; see [NOTICE](./NOTICE).

[Torque Pro](https://torque-bhp.com/) (Android) streams live OBD-II data from your
vehicle. `torque-dash-next` receives it over HTTPS, stores it in a time-series
database (TimescaleDB), and renders it in a React dashboard: live gauges, a route
map, session replays, and per-session summaries.

## Features

- **Docker-first deployment** — one `docker compose up` and you're running.
- **Time-series storage** — TimescaleDB hypertable + continuous aggregate for fast
  per-session queries over large log volumes.
- **React dashboard** — live vehicle view, route map (OpenStreetMap tiles, no API key), replay with a multi-series PID overlay chart (toggleable metric panel, collapsible stats table, y-axis capped at 4 axes total to prevent overcrowding), a session summary card with live SVG ring gauges (RPM, Coolant, Speed) that update as the playback cursor moves, and a settings page with upload API token management.
- **Session auto-naming** — new sessions are automatically named `Trip DDMMYYYY HH:MM AM/PM` on first upload.
- **Inline session rename** — rename sessions directly from the session table via an inline edit button (pencil icon, Enter/Escape/blur handling).
- **PID decode engine** — auto-discovers all OBD-II parameters from Torque's JSONB `values` column using embedded metadata (`userFullName*`/`userUnit*`) and a curated fallback map; no schema changes needed for new PIDs. Torque stores OBD‑II PIDs as hex keys without leading zeros (e.g. `kc` for RPM/PID 0x0C, `kd` for Speed/PID 0x0D).
- **Controlled ingestion** — email-gated uploads with an optional API-token
  (`Bearer`) bypass for Torque Pro over HTTPS; token can be generated from
  the Settings UI or set via the `UPLOAD_API_TOKEN` environment variable.
- **Operational guards** — rate-limited upload endpoint, togglable open
  registration, and environment-driven configuration.

## Architecture

| Layer     | Stack                                                        |
|-----------|-------------------------------------------------------------|
| Backend   | Node.js + Express 4, Sequelize 5, PostgreSQL / TimescaleDB |
| Frontend  | React 18 + Vite + TypeScript, ECharts, Leaflet, pidDecode  |
| Deploy    | Docker Compose: `db` (TimescaleDB) + `backend` + `frontend` (nginx) |

## Quick start (Docker — recommended)

```bash
git clone https://github.com/<you>/torque-dash-next.git
cd torque-dash-next

# (optional) generate a strong session secret + upload token
export SESSION_KEYS="$(openssl rand -hex 24)"
export UPLOAD_API_TOKEN="$(openssl rand -hex 24)"

docker compose up -d --build
```

Then open **http://localhost:8080**.

- On first boot the backend creates the database tables, turns the `Logs` table
  into a TimescaleDB hypertable, and seeds the `Settings` row. Data is persisted
  in the `pgdata` volume. Any unique indexes on the hypertable must include the
  partition column (`timestamp`) — the migration creates these automatically.
- Register the first account at the sign-up page, then sign in.
- For Torque Pro uploads, set `UPLOAD_API_TOKEN` (below) and point the app at
  `https://<host>/api/upload` with the matching bearer token.

> **Production note:** change `SESSION_KEYS` and set `COOKIE_SECURE=true` behind
> a TLS-terminating proxy. The compose defaults are for local/http use.

## Manual setup (without Docker)

**Backend**

```bash
npm install
createdb torquedash
export DATABASE_URL=postgres://user:pass@localhost:5432/torquedash
node scripts/migrate.js      # creates tables + hypertable + Settings row
npm start                    # or: node app.js
```

**Frontend**

```bash
cd apps/frontend
npm install
npm run dev                  # dev server with HMR, proxies /api -> http://localhost:3000
# production build:
npm run build                # outputs apps/frontend/dist
```

For a production SPA, serve `apps/frontend/dist` behind a reverse proxy that
forwards `/api` to the backend (the included `apps/frontend/nginx.conf` does this).

### Existing data: PID column backfill

> If you have existing sessions uploaded before July 2026, their
> `engine_rpm` and `vehicle_speed` columns may contain **stale or incorrect**
> values because Torque stores the PID keys as `kc` (RPM) and `kd` (Speed) — not
> the legacy `k4`/`k5` that the previous code expected. Run the backfill
> migration to repair existing data:
>
> ```sql
> -- infra/timescale/migrations/002_backfill_pid_columns.sql
> UPDATE "Logs"
> SET engine_rpm = CASE WHEN (values->>'kc') ~ '^-?\d+(\.\d+)?$'
>                       THEN (values->>'kc')::numeric ELSE NULL END,
>     vehicle_speed = CASE WHEN (values->>'kd') ~ '^-?\d+(\.\d+)?$'
>                          THEN (values->>'kd')::numeric ELSE NULL END
> WHERE values ? 'kc' AND values ? 'kd';
> ```
>
> Apply it via your database console or include it in your migration run. It is
> **idempotent** — safe to re-run.

## Configure Torque Pro

In Torque Pro → *Settings → Web Preferences*:

- **Server URL:** `https://<your-host>/api/upload`
- **Email address:** the email you registered with (used to link uploads to your
  account), or
- **Broadcast as HTTP** with a header `Authorization: bearer <UPLOAD_API_TOKEN>`
  (matches the `UPLOAD_API_TOKEN` env var) — lets you upload without exposing an
  email and works through HTTPS tunnels.

## Configuration (environment variables)

| Variable                   | Default                                  | Description                                                                 |
|----------------------------|------------------------------------------|-----------------------------------------------------------------------------|
| `DATABASE_URL`            | `postgres://postgres:heslo@localhost:5432/torquedash` | PostgreSQL/TimescaleDB connection string.                       |
| `PORT`                    | `3000`                                  | Backend HTTP port.                                                          |
| `NODE_ENV`                | _(unset)_                               | Set to `production` to skip `sequelize.sync()` (use migrations instead).    |
| `SESSION_KEYS`            | dev defaults                             | Comma-separated express-session secrets (array). **Set this in production.**|
| `COOKIE_SECURE`           | `false`                                 | `true` to set `Secure` on session cookies (requires HTTPS).                 |
| `COOKIE_SAMESITE`         | `lax`                                   | `SameSite` policy for session cookies.                                      |
| `CORS_ORIGINS`           | _(empty = same-origin only)_            | Comma-separated allowed origins for cross-origin API access. Also serves as the CSRF trust list — state-changing requests from any other origin are rejected (see `middleware/csrfGuard.js`). Entries must exactly match the browser `Origin` (correct scheme, no trailing slash). For local dev, use a consistent hostname for the API and SPA (e.g. both `localhost`) to avoid spurious 403s. |
| `PUBLIC_ORIGIN`           | _(unset)_                               | Overrides the expected CSRF origin. Set to the browser-visible origin (e.g. `https://app.example.com`) when nginx terminates HTTPS but forwards HTTP to the backend. |
| `UPLOAD_RATE_LIMIT_MAX`    | `600`                                   | Max uploads per `UPLOAD_RATE_LIMIT_WINDOW_MS` per IP.                       |
| `UPLOAD_RATE_LIMIT_WINDOW_MS` | `60000`                             | Upload rate-limit window in milliseconds.                                   |
| `UPLOAD_API_TOKEN`        | _(unset)_                               | If set, requests with `Authorization: bearer <token>` bypass the rate limit.|
| `AUTH_RATE_LIMIT_MAX`     | `10`                                    | Max login/register requests per window per IP.                              |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `60000`                               | Auth rate-limit window in milliseconds.                                     |
| `WRITE_RATE_LIMIT_MAX`    | `30`                                    | Max authenticated mutations (PUT settings/forwardurls) per window per IP.   |
| `WRITE_RATE_LIMIT_WINDOW_MS` | `60000`                              | Write rate-limit window in milliseconds.                                    |
| `READ_RATE_LIMIT_MAX`     | `600`                                   | Max requests to all other `/api` routes per window per IP (generous — the SPA polls telemetry during replay). |
| `READ_RATE_LIMIT_WINDOW_MS` | `60000`                               | Global `/api` rate-limit window in milliseconds.                            |
| `DISABLE_REGISTRATION`    | _(unset)_                               | If `true`, public sign-up is disabled (admin can still create accounts).    |

## License

MIT — see [LICENSE](./LICENSE). This project is a modernization of, and is
grateful for, the original [torque-dash](https://github.com/davekrejci/torque-dash)
by David Krejci. Attribution is recorded in [NOTICE](./NOTICE).
