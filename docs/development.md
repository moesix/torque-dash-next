# torqueDASH-Next — Development & Contributing

Guidance for contributors working on the torqueDASH-Next backend (repo root) and
the React/Vite frontend (`apps/frontend/`).

> **Known issues and follow-up items are documented below.** See the
> "Known Issues" section for scalability, security, and correctness gaps.

---

## 1. Prerequisites

- **Node.js 18+** and npm
- **PostgreSQL** with the **TimescaleDB** extension (`CREATE EXTENSION timescaledb;`)
- A Torque Pro device/app (or a scripted `GET /api/upload`) to generate data
- (Frontend only) a modern browser

---

## 2. Install

### Backend (repository root)
```sh
npm install
```
Installs Express 4, Sequelize 6, `pg`, Passport, Joi, bcrypt, express-session,
connect-pg-simple, cors, connect-flash, lodash, moment, nanoid, plus dev tooling
(eslint, morgan, nodemon).

### Frontend (`apps/frontend/`)
```sh
cd apps/frontend
npm install
```
Installs React 18, Vite 5, TypeScript 5, Tailwind v4, Tremor 3, ECharts 5,
react-leaflet 4, TanStack Query 5, zustand 4, react-router-dom 6.

---

## 3. Environment Variables

Set these at the backend repo root (`.env` or exported in the shell).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | **REQUIRED** — no default | Postgres/TimescaleDB connection string. App **crashes on startup** if missing. Also used by `scripts/migrate.js`. |
| `CORS_ORIGINS` | prod | `''` (empty) | Comma-separated list of SPA origins allowed to call `/api` **with cookies** (e.g. `https://app.example.com`). An empty value blocks all cross-origin SPA calls (see Known Issues, LOW). |
| `COOKIE_SECURE` | prod | unset (`lax`) | Set `true` in production to set `sameSite:none; secure` on the session cookie (required for cross-origin SPA auth). Dev (same-origin) keeps `lax` and works without HTTPS. |
| `NODE_ENV` | yes | unset | `production` **disables `sequelize.sync()`** so the TimescaleDB migration is the source of truth. Any other value runs `sequelize.sync()` on boot. |
| `PORT` | no | `3000` | Backend listen port. |
| `SESSION_KEYS` | **yes** | **REQUIRED** — no default | express-session secrets (array accepted via comma-separated string). App **crashes on startup** if missing or if a placeholder value is used. Generate with `openssl rand -hex 24`. |
| `PUBLIC_ORIGIN` | no | unset | Optional. Overrides the expected CSRF origin. Set to the browser-visible origin (e.g. `https://app.example.com`) when nginx terminates HTTPS but forwards HTTP to the backend, so `X-Forwarded-Proto` doesn't mislead the origin check. |
| `DISABLE_SYNC` | planned | — | Intended as an explicit kill-switch for `sequelize.sync()`. **Not yet wired** — today the sync gate is solely `NODE_ENV !== 'production'`. (Listed for forward compatibility; do not rely on it yet.) |
| `UPLOAD_RATE_LIMIT_MAX` | no | `600` | Max `/upload` requests per `UPLOAD_RATE_LIMIT_WINDOW_MS` window, per client IP. Raised from the original 60/min to absorb Torque reconnect bursts. |
| `UPLOAD_RATE_LIMIT_WINDOW_MS` | no | `60000` | Window length (ms) for the `/upload` rate limiter. |
| `UPLOAD_API_TOKEN` | no | unset | If set, uploads **REQUIRE** `Authorization: Bearer <token>` — without it, uploads return 401. This is a security gate: email alone is no longer sufficient. Can also be generated from the Settings UI (UI token takes precedence). |
| `DISABLE_REGISTRATION` | no | unset | Hard kill-switch: when `'true'`, `UserController.register` returns `403` and `GET /api/settings` reports `disableRegistration: true` regardless of the runtime `Settings` toggle. |
| `LLM_ENCRYPTION_KEY` | yes (AI) | unset | 64-char hex key for AES-256-GCM encryption of LLM API keys at rest. Generate with `openssl rand -hex 32`. Required when using the AI analysis feature. |

> The migration script (`scripts/migrate.js`) reads `DATABASE_URL`, falling back
> to `config/config.js` (`postgres://postgres:heslo@localhost:5432/torquedash`).

---

## 4. Running the Database Migration

The TimescaleDB schema (`infra/timescale/log_hypertable.sql`) is applied
manually, **not** on server boot:

```sh
node scripts/migrate.js
```

It:
1. Loads the SQL and splits it into individual statements.
2. Runs each statement via `pg`; benign "already exists" / "does not exist"
   errors are tolerated (idempotent re-runs).
3. Creates the `Logs` hypertable, promoted columns, the unique index on id (with
   the `timestamp` partition column — required by TimescaleDB), and the `log_1min`
   continuous aggregate.

Run this against a **TimescaleDB-enabled** database (the `timescaledb` extension
must exist). For large existing datasets, run in a maintenance window
(`migrate_data => true` re-chunks existing rows).

---

## 5. Running the Backend

```sh
node app.js
# or: npm start
```

- In non-production, the server runs `sequelize.sync()` then listens on `PORT`.
- In production (`NODE_ENV=production`), `sequelize.sync()` is skipped.
- `/health` returns `{ status: 'ok', ts }` for probes.

---

## 6. Running the Frontend

### Dev server (Vite)
```sh
cd apps/frontend
npm run dev
```
Vite serves the SPA (default `http://localhost:5173`) and **proxies `/api`** —
including the native `/api/upload` ingestion endpoint — to `http://localhost:3000`
(`vite.config.ts`). In dev the browser and API are same-origin, so the
`Lax` cookie works without HTTPS.

### Frontend build
```sh
cd apps/frontend
npm run build      # runs `tsc --noEmit && vite build` → apps/frontend/dist
```

> The backend does **not** currently serve `apps/frontend/dist` (it serves the
> legacy `public/`). In production the SPA is expected to be served by a separate
> origin/CDN or an nginx layer that proxies `/api` to the backend. See Known
> Issues (LOW).

---

## 7. Development Tooling

### 7.1 ESLint

The project uses **ESLint 8** for backend code with a project-local `.eslintrc.js`
configuration:

```sh
npm run lint
```

The config (`node` env, `es2022`, `eslint:recommended`) ignores
`apps/frontend/dist/` (Vite build output). Custom rules include:

- `no-unused-vars` set to `warn` (ignoring args prefixed with `_`).
- `no-console` is **off** — the server intentionally uses `console.log`/`console.error`.
- `no-empty` is `error` — empty catch blocks are forbidden.

### 7.2 Pre-commit Hooks (husky + lint-staged)

The project uses **husky 9** and **lint-staged 17** to run lint and syntax checks
on every commit:

- **husky** (`package.json` → `"prepare": "husky"`) installs Git hooks after
  `npm install`.
- **lint-staged** is configured in `package.json`:
  ```json
  "lint-staged": {
    "*.js": ["eslint --fix", "node -c"]
  }
  ```
  Before every `git commit`, staged `.js` files are checked with `eslint --fix`
  and validated with `node -c` (syntax check). If either step fails, the commit
  is blocked.

> First-time setup: run `npm install` (or `npm run prepare`) to initialise the
> husky hooks directory (`.husky/`).

### 7.3 CI Pipeline

A **GitHub Actions** workflow (`.github/workflows/ci.yml`) runs on every push
or pull request to the `development` branch:

- **Backend checks:** `npm ci` → `npm test` → `npm run lint`.
- **Frontend checks:** `npm ci` → `npx tsc --noEmit` (typecheck) → `npm run build`.

The workflow uses `actions/checkout@v7` and `actions/setup-node@v7` with npm
caching. The lint step currently has `continue-on-error: true` as a transitional
measure.

### 7.4 Versioning

A **Version Bump** workflow (`.github/workflows/version-bump.yml`) runs on every
push to `master`. It:

1. Analyses commits since the last tag using Conventional Commits heuristics to
   determine the bump type (major / minor / patch).
2. Runs `npm version <bump> --no-git-tag-version` to update `package.json` and
   `package-lock.json`.
3. Commits the result as `chore: release v<version>` and creates an annotated
   tag.
4. Pushes the commit and tag back to `master`.

> **Chaining to Docker builds:** pushes made with the default `GITHUB_TOKEN` do
> **not** trigger downstream workflows (like `docker-publish.yml`). To enable
> the chain, configure a PAT with `contents:write` as `secrets.GH_PAT` and
> replace the token reference in the `git push` step.

Docker images built by `docker-publish.yml` now include **semver tags** in
addition to the SHA and `latest` tags — `v<version>` and `<major>.<minor>` for
pinned deployments.

---

## 8. Known Issues / Follow-up Items

These are documented issues from code reviews. Severity is assigned per the review.

### Auth contract (SPA ↔ backend) ✅ RESOLVED

The auth contract mismatch (SPA vs backend) is **fixed**. All four original
blockers are resolved and re-reviewed as PASS:

1. ✅ `app.js` now registers `express.json({ limit: '1mb' })` on `/api`
   (before the api router) so JSON bodies populate `req.body`.
2. ✅ `middleware/auth.js` branches on `req.originalUrl.startsWith('/api')`
   and returns **401 JSON**; legacy HTML routes keep the redirect.
3. ✅ `models/User.js` `confirmPassword` is now `.optional()` (still validated
   when present).
4. ✅ `UserController.register`/`login` return **JSON** for `/api` requests
   (`201`/`{ ok: true }`) and call `req.logIn`; the SPA `login()` probes an
   auth-gated endpoint to confirm the cookie.

### High priority ✅ RESOLVED

- ✅ **Proxy rate-limit collapse fixed:** `app.js` calls `app.set('trust proxy', 1)`
  so `req.ip` reflects the real client behind the proxy.
- ✅ **Eager `Log` payload removed:** `SessionController.getAll`/`getOne` (and
  shared variants) no longer `include` the full `Log` array. They call the new
  `aggregateSummaries()` (one `GROUP BY` per request) and return lightweight
  `startDate`/`endDate`/`duration`/`maxSpeed`/`maxRpm`. Paged telemetry stays
  on `GET /api/sessions/:id/telemetry`.
- ✅ **CSRF protection added:** `middleware/csrfGuard.js` validates the `Origin`
  header on all state-changing `/api` requests against the expected origin and
  the `CORS_ORIGINS` allowlist (OWASP-recommended for JSON SPAs). The `publicOrigin`
  option handles deployments where nginx terminates HTTPS but forwards HTTP to
  the backend.

### Medium priority

- **SSRG guard has a DNS-rebinding TOCTOU.** `lib/ssrfGuard.isSafeUrl` resolves
  the hostname and validates the IP, but `UploadController` then calls
  `fetch(url)` with the **original hostname**, which re-resolves at connect time
  (attacker can swap the DNS record to an internal IP between check and fetch).
  **Fix:** resolve once, validate, then connect to the **validated IP** (e.g.
  pass an `URL` with the resolved address, or pin the resolved IP in the
  request).
- ✅ **`ingestBuffer` concurrency race + unbounded live buffer resolved.** A
  `flushing` boolean mutex prevents concurrent flush executions, and a
  `MAX_BUFFER_SIZE = 50000` hard cap drops oldest rows when exceeded (backpressure).
  See `services/ingestBuffer.js`.
- **Torque PID keys `kc`/`kd` are hardcoded.** `UploadController` promotes
  `values.kc` → `engine_rpm` and `values.kd` → `vehicle_speed`, but PIDs are
  user-configurable. A `torque-keys` mapping table should drive which PIDs map
  to the promoted columns instead of hardcoding `kc`/`kd`.
  - ⚠️ **Key format:** Torque stores OBD‑II PIDs as hex keys **without leading
    zeros** — PID 0x0C (RPM) → `kc`, PID 0x0D (Speed) → `kd`. This is the
    native Torque key format; never use `k4`/`k5` (decimal OBD‑II PIDs) or
    `k0c`/`k0d` (zero‑padded hex).
  - ⚠️ **Zero‑safe extraction:** always use the pattern
    `values.key != null ? Number(values.key) : null` instead of
    `Number(values.key) || null`. The latter discards legitimate zero values
    (idle RPM, stopped vehicle speed).

### Low priority

- **Empty `CORS_ORIGINS` blocks the cross-origin SPA.** `app.js` builds the CORS
  origin allowlist from `process.env.CORS_ORIGINS`. If unset/empty, the allowlist
  is `[]` and **all** cross-origin `/api` requests are refused. Must be set in
  production.
- **SPA build not served by Express.** `app.js` serves the legacy `public/`
  directory; `apps/frontend/dist` is not served. Confirm the deploy topology
  (separate origin/CDN, or an nginx layer proxying `/api` to the backend) — both
  are acceptable, but the choice affects cookie/CSRF handling.
- **`log_1min` continuous aggregate is unused.** The 1-minute continuous
  aggregate exists but no endpoint reads from it. Consider serving dashboard
  overviews from it to reduce load on the raw hypertable.
- ✅ **`duration` now formatted + stale comments swept.** `SessionController`
  formats `duration` into a compact human string (e.g. `"1h 02m 05s"`) via
  `moment-duration-format`; the legacy `addStartEndData` mutation path is gone and
  stale `302`/`addStartEndData` comments were removed from backend + frontend.

### Follow-up features (post-MVP)

- **Upload rate limit is now env-tunable + token-exempt.** `routes/api.js` caps
  `/upload` at `UPLOAD_RATE_LIMIT_MAX` (default 600) per
  `UPLOAD_RATE_LIMIT_WINDOW_MS` (default 60000). When `UPLOAD_API_TOKEN` is set,
  a matching `Authorization: Bearer <token>` header (a Torque app feature)
  bypasses the limiter so the known uploader's reconnect bursts never get `429`'d.
  The exemption is keyed on a secret token, not a spoofable query param.
- **Registration can be disabled.** Two layers: the env var `DISABLE_REGISTRATION`
  (`'true'`) is a hard kill-switch, and the runtime `Settings` singleton row
  (`disableRegistration` boolean, created by `infra/timescale/settings.sql`) is
  togglable by any logged-in user via `GET/PUT /api/settings`. `GET /api/settings`
  ORs in the env value so the SPA hides the signup form correctly when the env
  switch is active. `UserController.register` enforces both and returns `403`
  JSON. The SPA hides the signup form on `/login` and `/register` and a new
  `/settings` page exposes the toggle. **Operator model:** the app is
  single-operator, so ANY authenticated account may flip the toggle (there is no
  RBAC). Documented as intended, not a bug.
- **Upload API Token UI.** The `/settings` page additionally lets users generate,
  view (one-time), copy, and clear the upload Bearer token. The token is stored
  in the `Settings` DB row; when the `UPLOAD_API_TOKEN` env var is set, the UI
  reports the token as env-managed and disables the generate/clear buttons.
  `GET /api/settings` returns `hasUploadApiToken` / `tokenFromEnv` booleans, and
  `POST /api/settings/upload-token` generates a new random hex token.
- **PID Decode + Multi-series Overlay Chart.** The ReplayDashboard now features
  a single `OverlayChart.tsx` (replaces the old dual `TimeSeriesChart.tsx`) that
  renders all selected telemetry sources on a shared time axis with
  per-unit-group y-axes. A `PidTogglePanel` lets users search, filter by
  category, and toggle metrics on/off. A collapsible `DecodedMetricsTable` shows
  min/max/avg/last for every PID. The `pidDecode.ts` engine auto-discovers PID
  sources from the `values` JSONB column using embedded Torque metadata
  (`userFullName*`/`userUnit*`/`defaultUnit*`) with a curated fallback map for
  standard OBD-II PIDs. A pre-existing `RangeError` from spread-into-`Math.max`
  at ~10k frames has also been fixed. The old `TimeSeriesChart.tsx` was deleted.

---

## 9. Status

- **Core features complete:** ingestion, TimescaleDB migration, paged telemetry,
  React replay dashboard (overlay chart + imperative Leaflet marker), CSV export,
  session management, BYOK AI analysis.
- **Auth contract resolved and re-reviewed PASS.**
- **Verification:** frontend via `npm run build` (`tsc --noEmit && vite build`),
  backend via `node -c` syntax checks.
- **Additional features implemented:**
  - Env-tunable upload rate limit with trusted-email burst exemption.
  - Runtime-toggleable registration (`Settings` singleton +
    `DISABLE_REGISTRATION` env kill-switch + SPA `/settings` toggle).
  - **Upload API Token UI** on the `/settings` page (generate, view once, copy,
    clear; env override respected).
  - **PID Decode + Multi-series Overlay Chart**: `pidDecode.ts` auto-discovers
    all OBD-II PIDs from the `values` JSONB; `OverlayChart.tsx` renders multiple
    series with per-unit-group y-axes; `PidTogglePanel` provides search,
    category filtering, and selection management; `DecodedMetricsTable` shows
    per-PID aggregates.
  - `RangeError` on large datasets fixed (`safeMax` reduce replaces
    spread-into-`Math.max`).
  - **BYOK AI analysis** — connect any OpenAI-compatible LLM provider for
    per-session diagnostic insights. SSE streaming, cost confirmation dialog,
    syntax-highlighted markdown output.
  - **DeepSeek first-class** — `deepseek-v4-flash` / `deepseek-v4-pro` with
    toggleable Thinking Mode and configurable reasoning effort (High / Max).
    Migration 006 adds `llmThinkingMode` and `llmReasoningEffort` columns.
  - **LLM API keys encrypted at rest** with AES-256-GCM via `LLM_ENCRYPTION_KEY`.
  - **SSRF guard** (`lib/ssrfGuard.js`) validates custom LLM endpoints.
  - Docker-based deployment with GHCR images (`docker-compose.yml`).
  - Non-root backend container (`appuser`), unprivileged nginx frontend.
- **Dev tooling:** ESLint 8 (`.eslintrc.js`), husky 9 + lint-staged 17
  (pre-commit lint + syntax check), CI pipeline (`.github/workflows/ci.yml`)
  running on push/PR to `development`, and automated semver version bump
  (`.github/workflows/version-bump.yml`) on push to `master`.
- **Remaining open issues:** SSRF TOCTOU (documented in section 8 above).

---

## 10. Alternative Setup Methods

The sections below cover building from source and manual (non-Docker) setup. For
most users, the Docker quick start in the README or the full deployment guide
(`docs/deployment.md`) is sufficient.

### Build from source

```bash
git clone https://github.com/moesix/torque-dash-next.git
cd torque-dash-next

# **Required:** generate session keys (app crashes on startup if missing)
export SESSION_KEYS="$(openssl rand -hex 24)"
# Strongly recommended: upload token for Torque Pro authentication
# Can also be generated from the Settings UI after first login
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
- After adding all user accounts, disable public registration via the Settings
  UI or set `DISABLE_REGISTRATION=true` to prevent unauthorized sign-ups.

> **Production note:** `SESSION_KEYS` and `DATABASE_URL` are **required** (the
> app crashes on startup if missing). Set `COOKIE_SECURE=true` behind a
> TLS-terminating proxy. The compose defaults are for local/http use.

### Manual setup (without Docker)

**Backend**

```bash
npm install
createdb torquedash
export DATABASE_URL=postgres://user:pass@localhost:5432/torquedash
export SESSION_KEYS="$(openssl rand -hex 24)"   # Required — app crashes without it
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

> If you have existing sessions uploaded before July 2026, their
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
