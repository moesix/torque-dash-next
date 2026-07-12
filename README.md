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
- **React dashboard** — live vehicle view, route map (OpenStreetMap tiles, no API key), replay, and a settings page.
- **Controlled ingestion** — email-gated uploads with an optional API-token
  (`Bearer`) bypass for Torque Pro over HTTPS.
- **Operational guards** — rate-limited upload endpoint, togglable open
  registration, and environment-driven configuration.

## Architecture

| Layer     | Stack                                                        |
|-----------|-------------------------------------------------------------|
| Backend   | Node.js + Express 4, Sequelize 5, PostgreSQL / TimescaleDB |
| Frontend  | React 18 + Vite + TypeScript, ECharts, Leaflet             |
| Deploy    | Docker Compose: `db` (TimescaleDB) + `backend` + `frontend` (nginx) |

## Quick start (Docker — recommended)

```bash
git clone https://github.com/<you>/torque-dash-next.git
cd torque-dash-next

# (optional) generate a strong session key + upload token
export SESSION_KEYS="$(openssl rand -hex 24)"
export UPLOAD_API_TOKEN="$(openssl rand -hex 24)"

docker compose up -d --build
```

Then open **http://localhost:8080**.

- On first boot the backend creates the database tables, turns the `Logs` table
  into a TimescaleDB hypertable, and seeds the `Settings` row. Data is persisted
  in the `pgdata` volume.
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
| `SESSION_KEYS`            | dev defaults                             | Comma-separated cookie-signing keys. **Set this in production.**            |
| `COOKIE_SECURE`           | `false`                                 | `true` to set `Secure` on session cookies (requires HTTPS).                 |
| `COOKIE_SAMESITE`         | `lax`                                   | `SameSite` policy for session cookies.                                      |
| `CORS_ORIGINS`            | _(empty = same-origin only)_            | Comma-separated allowed origins for cross-origin API access.                 |
| `UPLOAD_RATE_LIMIT_MAX`    | `600`                                   | Max uploads per `UPLOAD_RATE_LIMIT_WINDOW_MS` per IP.                       |
| `UPLOAD_RATE_LIMIT_WINDOW_MS` | `60000`                             | Upload rate-limit window in milliseconds.                                   |
| `UPLOAD_API_TOKEN`        | _(unset)_                               | If set, requests with `Authorization: bearer <token>` bypass the rate limit.|
| `DISABLE_REGISTRATION`    | _(unset)_                               | If `true`, public sign-up is disabled (admin can still create accounts).    |

## License

MIT — see [LICENSE](./LICENSE). This project is a modernization of, and is
grateful for, the original [torque-dash](https://github.com/davekrejci/torque-dash)
by David Krejci. Attribution is recorded in [NOTICE](./NOTICE).
