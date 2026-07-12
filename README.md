# TorqueDashNext

> Web dashboard + logging server for the [Torque Pro](https://play.google.com/store/apps/details?id=org.prowl.torque&hl=en) Android OBD2 app.

TorqueDashNext is a **Tier-2 modernization** of the archived OSS project
[`torque-dash`](https://github.com/davekrejci/torque-dash). It keeps the
original Express + Sequelize + PostgreSQL server and all of its features
(auth, share-IDs, `forwardUrls`, session copy/join/filter/cut/rename/addLocation)
while hardening the data layer with **TimescaleDB**, optimizing the ingestion
path, paginating session endpoints, and replacing the old jQuery/Bootstrap
frontend with a **React/Vite SPA**.

---

## Modernized Stack

**Backend** (repository root)
- Node.js + **Express 4** (server-rendered with Express-Handlebars for legacy views)
- **Sequelize 5** ORM over **PostgreSQL**, upgraded to a **TimescaleDB** hypertable (`Logs`)
- Auth: Passport + `passport-local`, `cookie-session`, `bcrypt`, `connect-flash`
- Validation: **Joi**
- Logging: Morgan
- Tests: Jest · Lint: ESLint

**Frontend** (`apps/frontend/`)
- **React 18 + TypeScript + Vite**
- **Tailwind CSS** + **Tremor** (UI components)
- **ECharts** (`echarts/core`) for synced time-series charts
- **react-leaflet** for the GPS track map
- **TanStack Query** for data fetching · **zustand** for the playback cursor store

---

## Quickstart

### 1. Prerequisites
- Node.js 18+ and npm
- A **PostgreSQL** instance with the **TimescaleDB** extension installed
- (Optional) the `torque-dash-next` frontend build in `apps/frontend/dist`

### 2. Install

Backend (repository root):
```sh
npm install
```

Frontend (separate workspace):
```sh
cd apps/frontend
npm install
```

### 3. Set environment variables

Create a `.env` (or export) at the repo root. Minimum needed:

| Variable        | Purpose                                                        |
| --------------- | -------------------------------------------------------------- |
| `DATABASE_URL`  | Postgres/TimescaleDB connection string                         |
| `CORS_ORIGINS`  | Comma-separated SPA origins allowed to call `/api` (with cookies) |
| `COOKIE_SECURE` | `true` in production (sets `sameSite:none; secure` on cookie)  |
| `NODE_ENV`      | `production` disables `sequelize.sync()` (migrations are source of truth) |
| `PORT`          | Backend port (default `3000`)                                  |

See [`docs/development.md`](docs/development.md) for the full env-var table.

### 4. Run the database migration

`scripts/migrate.js` applies `infra/timescale/log_hypertable.sql` (creates the
`Logs` hypertable, promoted columns, index, and the `log_1min` continuous
aggregate). It must be run against a **TimescaleDB**-enabled database:

```sh
node scripts/migrate.js
```

### 5. Start the backend

```sh
node app.js
# or: npm start
```

### 6. Start the frontend (dev)

In `apps/frontend/`, Vite serves the SPA and proxies `/api` (including the
native `/api/upload` ingestion endpoint) to the backend on `:3000`:

```sh
cd apps/frontend
npm run dev
```

Open the Vite URL (default `http://localhost:5173`).

### 7. Point Torque Pro at the ingest URL

1. Register an account in TorqueDashNext (via the SPA).
2. In **Torque Pro → Settings → User email**, set the same email as your account.
3. In **Torque Pro → Settings → Webserver URL**, set:
   ```
   https://<your-host>/api/upload
   ```
   Torque Pro sends data as `GET /api/upload?eml=<email>&session=...&time=...&kff1005=...&kff1006=...&k4=...&k5=...`.
   Uploads from an **unknown email are rejected with `403`** and are never
   buffered or forwarded.

---

## Fork & License

TorqueDashNext is a fork of [`torque-dash`](https://github.com/davekrejci/torque-dash),
originally created by **David Krejci** and distributed under the **MIT License**.

- This project is distributed under the **MIT License** — see [`LICENSE`](LICENSE).
- The upstream `LICENSE.txt` (David Krejci's original MIT notice) is preserved at the repo root.
- Attribution to the original project is recorded in [`NOTICE`](NOTICE).

> ⚠️ Note: `package.json` at the repo root currently declares `"license": "ISC"`
> (a legacy manifest value). The **actual** license — per `LICENSE.txt` and the
> new `LICENSE` — is **MIT**. This discrepancy should be corrected in `package.json`.

---

## Documentation

- [System architecture](docs/architecture.md) — components, data flow, ingestion & replay internals.
- [Development & contributing](docs/development.md) — prerequisites, env vars, running, and the **Known Issues / Pre-MVP Fixes** list.

---

## Status

MVP implementation is complete **pending the blocker fixes listed in
[`docs/development.md`](docs/development.md#known-issues--pre-mvp-fixes)** (the
backend auth contract is currently broken for the SPA). The frontend is verified
via `vite build` / `tsc`; the backend is syntax-checked via `node -c`. The system
has **not yet been run end-to-end against a live TimescaleDB instance**.
