# TorqueDashNext — Tier 2 Modernization Plan (corrected)

> Incremental modernization of the existing Express + Sequelize + PostgreSQL app.
> Keeps the Express API server and ALL existing features (auth, share-IDs,
> `forwardUrls`, session copy/join/filter/cut/rename/addLocation). Only the data
> layer is hardened with TimescaleDB, the ingestion path is optimized, session
> endpoints are paginated, and the jQuery/Bootstrap frontend is replaced by a
> React/Vite SPA.
>
> This document is the corrected version after a `code-reviewer` pass. Every
> 🔴 blocker from that review is addressed inline.

## 0. Verified facts about the current code (from code review)
- `Log.timestamp` is `DataTypes.DATE` → on PostgreSQL this is **`timestamptz` already**.
- `Log.values` is **`DataTypes.JSONB`** (so `->>` works).
- No `underscored: true` anywhere → DB columns are **camelCase**: `sessionId`, not `session_id`.
- `Log` has no explicit `id`, so Sequelize auto-creates `id SERIAL PRIMARY KEY`.
- GPS arrives as `kff1005` (lon) / `kff1006` (lat); non-GPS uploads are currently dropped.
- `forwardUrls` are server-fetched with **zero URL validation** (SSRF surface).
- `app.js` uses `cors()` (wildcard, no credentials) and `cookie-session` with **no `sameSite`/`secure`**.
- `app.js` calls `sequelize.sync()` on startup.

## 1. Blockers fixed (must hold during implementation)
1. **Do NOT `ALTER COLUMN timestamp TYPE timestamptz`** — it is already timestamptz; the `USING ... AT TIME ZONE 'UTC'` clause would shift all history on non-UTC servers.
2. **Restructure the PK before `create_hypertable`** — TimescaleDB requires the time column in the PK. Keep `id` globally unique (existing `filter`/`cut`/`join` logic uses `log.id` alone).
3. **Use `"sessionId"` (camelCase) in all SQL**, never `session_id`.
4. **Guard `forwardUrls` against SSRF** (scheme + private/loopback/link-local/metadata IP block) — moving it async is NOT sufficient.
5. **Set `sameSite:'none', secure:true` on the session cookie** (secure gated by env) or the SPA cannot authenticate cross-origin.

## 2. Phase A — Data layer (`infra/timescale/log_hypertable.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 1. Restructure PK: time column must be in the PK.
--    Keep `id` globally unique for id-based ops (filter/cut/join).
ALTER TABLE "Logs" DROP CONSTRAINT "Logs_pkey";
CREATE UNIQUE INDEX logs_id_uidx ON "Logs"(id);
ALTER TABLE "Logs" ADD PRIMARY KEY ("sessionId", timestamp);

-- 2. Explicit dedupe constraint (helps bulkCreate ON CONFLICT + clarity)
ALTER TABLE "Logs" ADD CONSTRAINT logs_session_timestamp_uniq UNIQUE ("sessionId", timestamp);

-- 3. Promoted hot columns (populated at ingest + backfilled)
ALTER TABLE "Logs" ADD COLUMN IF NOT EXISTS "engine_rpm" double precision;
ALTER TABLE "Logs" ADD COLUMN IF NOT EXISTS "vehicle_speed" double precision;

-- 4. Hypertable (migrate existing data; run in a maintenance window)
SELECT create_hypertable('"Logs"', 'timestamp',
       chunk_time_interval => INTERVAL '1 day',
       migrate_data => true);

-- 5. Index for the dominant access pattern
CREATE INDEX IF NOT EXISTS logs_session_time_idx ON "Logs" ("sessionId", timestamp DESC);

-- 6. Continuous aggregate over promoted columns (safe; backfilled)
CREATE MATERIALIZED VIEW IF NOT EXISTS log_1min
WITH (timescaledb.continuous) AS
SELECT "sessionId",
       time_bucket('1 minute', timestamp) AS bucket,
       avg("engine_rpm")    AS avg_rpm,
       max("engine_rpm")    AS max_rpm,
       avg("vehicle_speed") AS avg_speed_kmh,
       max("vehicle_speed") AS max_speed_kmh,
       count(*)             AS n
FROM "Logs"
GROUP BY "sessionId", bucket;

SELECT add_continuous_aggregate_policy('log_1min',
       start_offset => INTERVAL '10 minutes',
       end_offset   => INTERVAL '1 minute',
       schedule_interval => INTERVAL '1 minute');
```

Backfill script (one-off): `UPDATE "Logs" SET "engine_rpm" = NULLIF(values->>'k4','')::numeric, "vehicle_speed" = NULLIF(values->>'k5','')::numeric WHERE "engine_rpm" IS NULL;`

`scripts/migrate.js` runs the SQL file via `pg` (idempotent; guard with `DISABLE_SYNC`).

**Model change (`models/Log.js`):** add `engine_rpm: { type: DataTypes.FLOAT, allowNull: true }` and `vehicle_speed: { type: DataTypes.FLOAT, allowNull: true }`. Do NOT add `paranoid`.

## 3. Phase B — Ingestion optimization
- `services/ingestBuffer.js`: `node-cache` LRU (5-min TTL) caching **both** positive and negative `email → user` lookups; buffer array flushed every 1000 rows or 1s via `Log.bulkCreate(batch, { ignoreDuplicates: true })`. Log+swallow flush failures (document telemetry loss on crash).
- `UploadController.processUpload`: resolve user via cache; keep the **403 reject for unknown emails** (never buffer/forward unknown); `findOrCreate` session and **store the resolved numeric FKs (`user.id`, `session.id`) in the buffer row** (not emails); stop dropping non-GPS uploads (store nulls); call `ingest()` and respond `200 OK` immediately.
- `lib/ssrfGuard.js`: `isSafeUrl(url)` → allow only `http`/`https`, resolve hostname, reject private/loopback/link-local/`169.254.169.254`. `forwardUrls` fan-out becomes async (`setImmediate`/fire-and-forget) using native `fetch` with `AbortController` timeout, skipped if `!isSafeUrl`.
- Dedupe is now ms-granular (`new Date(Number(time))`); acknowledge row-count growth vs old per-second collapsing.

## 4. Phase C — API
- **Disable `sequelize.sync()` in production** (`if (process.env.NODE_ENV !== 'production') await sequelize.sync();`); migrations are source of truth.
- **CORS**: replace global `cors()` with an explicit allowlist + `credentials: true` scoped to `/api` (the Torque native app hitting `/api/upload` sends no Origin/cookie, so CORS is irrelevant to it).
- **Cookie**: `cookieSession({ ..., cookie: { httpOnly: true, sameSite: process.env.COOKIE_SECURE === 'true' ? 'none' : 'lax', secure: process.env.COOKIE_SECURE === 'true' } })`.
- **`GET /api/sessions/:id/telemetry?from&to&limit`** (`TelemetryController.range`): enforce `userId` ownership (mirror `SessionController.getOne`); support `?shareId=` for shared sessions; `Log.findAll` with `Op.between`, capped `limit` (≤10000), ordered ASC, limited attributes.
- **`GET /health`** for probes.
- Add `express-rate-limit` on `/api/upload` and `/api/users/*`.

## 5. Phase D/E — Frontend (React/Vite SPA in `apps/frontend/`)
- Stack: React + TS + Vite + Tailwind + Tremor + ECharts (`echarts/core`) + react-leaflet + TanStack Query + react-router + zustand.
- Auth: forms POST to existing `/api/users/login|register|logout`; `fetch` with `credentials: 'include'`.
- `SessionBrowser` (Tremor Table) ← `GET /api/sessions`; row click → `ReplayDashboard`.
- `ReplayDashboard`: ECharts time-series (RPM/Speed) synced via `echarts.connect()`; react-leaflet GPS track; **imperative `marker.setLatLng(...)`** driven by a zustand `cursorTime` (binary-search timestamp→lat/lon); never wrap `<MapContainer>` in cursor state.
- `vite.config.ts` proxies `/api` (and the native `/api/upload`) → `http://localhost:3000`.
- **Dev vs prod**: dev proxy is same-origin (Lax cookie works); prod needs the CORS allowlist + `sameSite:none;secure`. Test the real cross-origin topology.

## 6. Roadmap
A. Data layer → B. Ingest opt → C. API → D. Frontend scaffold+auth+browser → E. Replay dashboard (MVP) → code-reviewer → project-analyst docs.

## 7. API contract (shared by backend + frontend)
| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/users/register` | none | register |
| `POST /api/users/login` | none | login (sets cookie) |
| `GET /api/users/logout` | cookie | logout |
| `GET /api/sessions` | cookie | list sessions (summary) |
| `GET /api/sessions/:id` | cookie+owner | session metadata (no full logs) |
| `GET /api/sessions/:id/telemetry?from&to&limit` | cookie+owner | paged telemetry frames |
| `GET /api/sessions/:id/shared/:shareId` | shareId | shared view |
| `POST /api/upload` (`/upload` from Torque) | none (email-gated) | ingest |
| `GET /health` | none | probe |
