# TorqueDash-Next — Development & Contributing

Guidance for contributors working on the TorqueDash-Next backend (repo root) and
the React/Vite frontend (`apps/frontend/`).

> **Known issues and follow-up items are documented below.** See the
> "Known Issues" section for scalability, security, and correctness gaps.

---

## 1. Prerequisites

- **Node.js 22** (LTS) and npm — the Docker images are built on
  `node:22-bookworm-slim` and CI runs on Node 22. Vite 8 requires Node
  **20.19+ / 22.12+**, so Node 22 is the supported floor.
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
connect-pg-simple, cors, helmet, nanoid, plus dev tooling
(eslint, @eslint/js, globals, husky, lint-staged, nodemon).

### Frontend (`apps/frontend/`)
```sh
cd apps/frontend
npm install
```
Installs React 19, Vite 8, TypeScript 7, Tailwind CSS 4, ECharts 6,
react-leaflet 5, TanStack Query 5, zustand 5, react-router 8.3.0 (exact
pin). No Tremor — all UI uses native Tailwind utilities (Plan 049).

> **react-router version:** Exact-pinned to **8.3.0** (not `^8.3.0`) as the
> single `react-router` package. Plan 045 migrated from `react-router-dom`
> 6.30.4 to `react-router` 7.18.2, resolving the two 6.x Dependabot advisories
> (GHSA-wrjc-x8rr-h8h6 backslash open redirect, GHSA-337j-9hxr-rhxg constructor
> injection via SSR hydration); Plan 047 then upgraded to **8.3.0**, which also
> resolves the previously tracked GHSA-qwww-vcr4-c8h2 advisory (high, RSC-mode
> CSRF, affected react-router 7.12.0–8.2.0). All frontend imports come from
> `react-router` (the `createBrowserRouter` + `RouterProvider` pattern).

---

## 3. Environment Variables

Set these at the backend repo root (`.env` or exported in the shell).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | **REQUIRED** — no default | Postgres/TimescaleDB connection string. App **crashes on startup** if missing. Also used by `scripts/migrate.js`. |
| `CORS_ORIGINS` | prod | `''` (empty) | Comma-separated list of SPA origins allowed to call `/api` **with cookies** (e.g. `https://app.example.com`). An empty value blocks all cross-origin SPA calls (see Known Issues, LOW). |
| `COOKIE_SECURE` | prod | unset (`lax`) | Set `true` in production to set `sameSite:none; secure` on the session cookie (required for cross-origin SPA auth). Dev (same-origin) keeps `lax` and works without HTTPS. `SameSite` is derived from this variable in `app.js` — there is no separate `COOKIE_SAMESITE`. **Set `COOKIE_SECURE=true` / terminate TLS at the edge before using BYOK LLM keys** — an unencrypted deployment would ship LLM API keys over plain HTTP. |
| `NODE_ENV` | no | unset | Optional. `production` skips the **app-internal** `sequelize.sync()` in `app.js`; any other value runs it on boot. This does NOT stop the Docker CMD bootstrap — the image runs an idempotent `sequelize.sync()` before `scripts/migrate.js` on **every** boot regardless of NODE_ENV. Migrations remain the source of truth for TimescaleDB-specific DDL (hypertable, continuous aggregate); base tables are sync-maintained. |
| `PORT` | no | `3000` | Backend listen port. |
| `SESSION_KEYS` | **yes** | **REQUIRED** — no default | express-session secrets (array accepted via comma-separated string). App **crashes on startup** if missing or if a placeholder value is used. Generate with `openssl rand -hex 24`. |
| `PUBLIC_ORIGIN` | no | unset | Optional. Overrides the expected CSRF origin. Set to the browser-visible origin (e.g. `https://app.example.com`) when nginx terminates HTTPS but forwards HTTP to the backend, so `X-Forwarded-Proto` doesn't mislead the origin check. |
| `DISABLE_SYNC` | planned | — | Intended as an explicit kill-switch for `sequelize.sync()`. **Not yet wired** — today the sync gate is solely `NODE_ENV !== 'production'`. (Listed for forward compatibility; do not rely on it yet.) |
| `UPLOAD_RATE_LIMIT_MAX` | no | `600` | Max `/upload` requests per `UPLOAD_RATE_LIMIT_WINDOW_MS` window, per client IP. Raised from the original 60/min to absorb Torque reconnect bursts. |
| `UPLOAD_RATE_LIMIT_WINDOW_MS` | no | `60000` | Window length (ms) for the `/upload` rate limiter. |
| `UPLOAD_API_TOKEN` | yes (production) | unset | Uploads **REQUIRE** `Authorization: Bearer <token>` once a token is configured — without a matching header they return 401. Email alone is sufficient only when no token exists anywhere (discouraged bootstrap mode; insecure for production). Precedence: the env value always wins and locks the Settings UI (generate/clear return 403 while env-managed); without env, the Settings-UI/DB token applies. Generate with `openssl rand -hex 24`. Matching-token requests also bypass the per-IP upload rate limiter. |
| `DISABLE_REGISTRATION` | no | unset | Hard kill-switch: when `'true'`, `UserController.register` returns `403` and `GET /api/settings` reports `disableRegistration: true` regardless of the runtime `Settings` toggle. |
| `LLM_ENCRYPTION_KEY` | yes (AI) | unset | 64-char hex key for AES-256-GCM encryption of LLM API keys at rest. Generate with `openssl rand -hex 32`. Required when using the AI analysis feature. |

> The migration script (`scripts/migrate.js`) reads `DATABASE_URL`, falling back
> to `config/config.js` (`postgres://postgres:heslo@localhost:5432/torquedash`).

---

## 4. Running the Database Migration

The migration script (`scripts/migrate.js`) loads **every `.sql` file** under
`infra/timescale/` — it walks the directory **recursively**, so the legacy
nested `migrations/002_backfill_pid_columns.sql` is discovered and applied
after the numbered top-level series — in lexicographic order and executes each
statement via `pg`. A `_migrations` tracker table records each file by
`(filename, content_hash)`; unchanged files are skipped, edited files are
re-run.

**In Docker, migrations run automatically.** The backend container's CMD
(`Dockerfile`) executes `node scripts/migrate.js` at every container start,
so `docker compose up -d` applies any pending migrations — no manual step
needed for Docker deployments. The CMD first runs an idempotent
`sequelize.sync()` bootstrap **unconditionally** (regardless of NODE_ENV): any
missing base tables are created by sync, then migrate.js applies the
TimescaleDB-specific DDL (`Logs` hypertable, continuous aggregate) and seeds
Settings. A manual run is only required for **non-Docker (manual) setups**:

```sh
node scripts/migrate.js
```

The script:
1. Reads all `.sql` files from `infra/timescale/` (recursively), sorted by
   relative filename (top-level `0NN_*` files sort before `migrations/*`).
2. Strips SQL comments and splits each file into individual statements on `;`.
3. Runs each statement via `pg`; benign "already exists" / "does not exist"
   errors are tolerated (idempotent re-runs). A file is marked applied in the
   tracker only once all its statements succeed.

**Current migration files** — top-level series `001`–`020` (in execution order):

| File | Purpose |
| --- | --- |
| `001_log_hypertable.sql` | Creates the `Logs` hypertable, promoted columns `engine_rpm` / `vehicle_speed`, unique index on `id`, and the `log_1min` continuous aggregate |
| `002_settings.sql` | Seeds the `Settings` singleton row (misc global configuration) |
| `003_add_llm_settings.sql` | Adds `llmProvider`, `llmModel`, `llmEndpoint`, `llmApiKey` columns to Settings |
| `004_add_analyses_table.sql` | Creates the `Analyses` table for cached AI analysis results |
| `005_add_analysis_reasoning.sql` | Adds `reasoning` column to `Analyses` (stores LLM chain-of-thought) |
| `006_add_deepseek_settings.sql` | Adds `llmThinkingMode` and `llmReasoningEffort` columns to Settings |
| `007_add_timezone_offset.sql` | Adds `timezoneOffset` column to Settings for session name formatting |
| `008_add_session_notes.sql` | Adds nullable `notes` TEXT column to Sessions |
| `009_add_vehicles.sql` | Creates the `Vehicles` table and adds `vehicleId` FK to Sessions |
| `010_add_llm_max_tokens.sql` | Adds `llmMaxTokens` INTEGER column to Settings (NOT NULL, default 16384) |
| `011_add_retention_settings.sql` | Adds `retentionEnabled` BOOLEAN (NOT NULL, default false) and `retentionDays` INTEGER (NOT NULL, default 365) columns to Settings for the data retention policy |
| `012_upload_token.sql` | Numbering placeholder — the upload token column already lives in `002_settings.sql` |
| `013_users_sessions_baseline.sql` | Idempotent `Users`/`Sessions` baseline DDL for sync-less databases (benign skips when sync created them) |
| `014_add_token_version.sql` | Adds `Users.tokenVersion` INTEGER (default 0) — compared against the session cookie to invalidate stale sessions after a password change |
| `015_normalize_emails.sql` | One-time lowercase fold of all existing `Users.email` values |
| `016_denormalize_summaries.sql` | Adds `Sessions.firstTimestamp` / `lastTimestamp` summary columns (Plan 064) |
| `017_user_admin.sql` | Adds `Users.isAdmin` BOOLEAN (default false); first-user bootstrap rule + lowest-id backfill for upgraded deployments (Plan 099) |
| `018_drop_forward_urls.sql` | Drops the retired webhook forward-column from Users (Plan 120) |
| `019_analysis_retention.sql` | Adds nullable `Settings.analysisRetentionDays` INTEGER for the app-side Analyses prune job (Plan 121) |
| `020_analyses_created_id_unique.sql` | UNIQUE index on `Analyses("createdAt", "id")` — formalizes the keyset-pagination order |

Nested under `migrations/`: `001_add_upload_token.sql` (no-op placeholder) and
`002_backfill_pid_columns.sql` — the legacy `engine_rpm`/`vehicle_speed`
backfill for pre-July-2026 data (Torque's `kc`/`kd` keys; see §12).

Run this against a **TimescaleDB-enabled** database (the `timescaledb` extension
must exist). For large existing datasets, run in a maintenance window
(`migrate_data => true` re-chunks existing rows).

---

## 5. Running the Backend

```sh
node app.js
# or: npm start
```

- In non-production, the server runs its own `sequelize.sync()` then listens on `PORT`.
- In production (`NODE_ENV=production`), the server skips its own `sequelize.sync()`.
- When run from the Docker image, the CMD additionally runs an idempotent
  `sequelize.sync()` bootstrap before `scripts/migrate.js` on every boot —
  regardless of NODE_ENV (see §4).
- `/health` returns `{ status: 'ok', ts }` for probes.

---

## 6. Model & Controller Patterns

The Vehicle model (`models/Vehicle.js`) and controller
(`controllers/VehicleController.js`) serve as the reference pattern for adding
new entities. Key conventions:

### 6.1 Model (`models/Vehicle.js`)
- Sequelize model with explicit field types, `allowNull`, and `defaultValue`.
- **Associations** defined in an `associate` function — projects `belongsTo`/`hasMany`
  from both sides so Sequelize resolves foreign keys correctly.
- Dynamically loaded by `models/index.js` (auto-reads all files in the `models/`
  directory), no registration step needed.
- Example from `Vehicle`:
  ```js
  Vehicle.associate = function (models) {
      Vehicle.belongsTo(models.User, { as: 'User', foreignKey: 'userId' });
      Vehicle.hasMany(models.Session, {
          as: 'Sessions',
          foreignKey: { name: 'vehicleId', allowNull: true },
          onDelete: 'set null',
      });
  };
  ```

### 6.2 Controller (`controllers/VehicleController.js`)
- Static methods on a class, one per action: `getAll`, `getOne`, `create`,
  `update`, `delete`, plus domain-specific actions like `setDefault`.
- **Ownership scoping** — every query includes `where: { userId: req.user.id }`
  so users can only access their own data.
- **Validation** — early returns with `4xx` JSON errors before database writes.
- **Error handling** — try/catch with `console.error` + `500` JSON response.
- No Express `router` registration in the controller — routes are defined in
  `routes/api.js`.

### 6.2a Extracted Helpers (`SessionController.js`)
`SessionController` extracts shared logic into standalone functions (exported
on the module):

| Helper | Purpose |
|--------|---------|
| `loadOwnedSession(sessionId, userId)` | Single `Session.findOne` with ownership scoping — used by `updateNotes`, `cut`, `filter`, `copy`, `join`, `reassignVehicle`. |
| `decorateWithSummaries(session, summary)` | Merges aggregate fields (`startDate`, `endDate`, `duration`, `maxSpeed`, `maxRpm`) onto a session JSON object. |
| `aggregateSummaries(sessionIds)` | Single `GROUP BY` query across multiple session IDs — computes `min(timestamp)`, `max(timestamp)`, `max(vehicle_speed)`, `max(engine_rpm)` in one pass. Replaces the legacy pattern of loading full `Log` arrays per session. |
| `formatDuration(start, end)` | Formats a `[start, end]` pair into a compact human string (e.g. `"1h 2m 5s"`). |
| `sanitizeFilename(name)` | Strips path-dangerous chars from session names for `Content-Disposition` filenames. |
| `csvEscape(val)` | Escapes a single CSV cell, including Excel formula injection guard. |

### 6.3 Routes (`routes/api.js`)
- Route → controller mapping is explicit in `routes/api.js`:
  ```js
  const VehicleController = require('../controllers/VehicleController');
  // ── Vehicle CRUD ──
  router.get('/vehicles', authenticate, VehicleController.getAll);
  router.post('/vehicles', writeLimiter, authenticate, VehicleController.create);
  router.put('/vehicles/:vehicleId', writeLimiter, authenticate, VehicleController.update);
  router.delete('/vehicles/:vehicleId', writeLimiter, authenticate, VehicleController.delete);
  router.patch('/vehicles/:vehicleId/default', authenticate, VehicleController.setDefault);
  ```
- Write operations use `writeLimiter` rate limiter; reads use `authenticate` only.

### 6.4 Migration SQL (`infra/timescale/009_add_vehicles.sql`)
- Raw SQL with `IF NOT EXISTS` / idempotent guards. Lexicographic filename
  ordering determines execution order (e.g. `008_` runs before `009_`).

### 6.5 Joi Validation Pattern (`lib/validators.js`)
Input validation is centralised in `lib/validators.js` using **Joi** schemas.
Controllers import the relevant schema and call `.validate(req.body)` early,
returning `400` with the first error detail on failure:

```js
const { renameSchema } = require('../lib/validators');
// ...
const { error: valErr } = renameSchema.validate(req.body);
if (valErr) {
    return res.status(400).json({ error: valErr.details[0].message });
}
```

**Exported schemas:**

| Schema | Used by | Purpose |
|--------|---------|---------|
| `renameSchema` | `SessionController.rename` | `{ name: string, 1–255 chars }` |
| `notesSchema` | `SessionController.updateNotes` | `{ notes: string\|null, max 10000 }` |
| `cutSchema` | `SessionController.cut` | `{ from, to }` ISO dates with `from ≤ to` custom validator |
| `filterSchema` | `SessionController.filter` | `{ filterNumber: int 2–100000 }` |
| `copySchema` | `SessionController.copy` | `{ name: string, required }` |
| `joinSchema` | `SessionController.join` | `{ joinSessionId: positive int, name: string }` |
| `addLocationSchema` | `SessionController.addLocation` | `{ locations: { start, end } }` strings |
| `vehicleCreateSchema` | `VehicleController.create` | Vehicle fields: `name` required, `make`/`model`/`year`/`engineCc`/`vin` optional |
| `vehicleUpdateSchema` | `VehicleController.update` | Same as create, all optional, `min(1)` — at least one field required |
| `telemetryRangeSchema` | `TelemetryController.range` | `{ from, to }` ISO dates + `limit` (1–10000, default 5000) + `offset` (≥0) — wired so a malformed range returns `400`, not a `500` |

**Pure validation helpers** (used by `UserController.updateSettings`):

| Helper | Validates |
|--------|-----------|
| `validateProvider(v)` | LLM provider against `PROVIDER_ALLOWLIST` (`openai`, `anthropic`, `ollama`, `deepseek`, `custom`) |
| `validateLlmThinkingMode(v)` | Boolean |
| `validateLlmMaxTokens(v)` | Integer 2048–32768 |
| `validateRetentionEnabled(v)` | Boolean |
| `validateRetentionDays(v)` | Integer 90–365 |
| `validateAnalysisRetentionDays(v)` | Integer 90–365, or null/undefined (disabled) — analysis-retention setting (Plan 121) |

---

## 7. Running the Frontend

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

### Frontend API client (`lib/api.ts`)

The API client at `apps/frontend/src/lib/api.ts` provides typed fetch wrappers
for all backend endpoints. Vehicle/notes functions date from Plans 040–041;
analysis/settings wrappers were added with those features:

| Function | Endpoint | Purpose |
| --- | --- | --- |
| `getVehicles()` | `GET /api/vehicles` | List all vehicles |
| `getVehicle(id)` | `GET /api/vehicles/:id` | Get a single vehicle |
| `createVehicle(body)` | `POST /api/vehicles` | Create a new vehicle |
| `updateVehicle(id, body)` | `PUT /api/vehicles/:id` | Update a vehicle |
| `deleteVehicle(id)` | `DELETE /api/vehicles/:id` | Delete a vehicle |
| `setDefaultVehicle(id)` | `PATCH /api/vehicles/:id/default` | Set as default vehicle |
| `reassignSessionVehicle(sessionId, vehicleId)` | `PATCH /api/sessions/:sessionId/vehicle` | Reassign session to a vehicle |
| `updateSessionNotes(sessionId, notes)` | `PATCH /api/sessions/notes/:sessionId` | Update session notes |
| `getSettings()` | `GET /api/settings` | Public settings — **only** `{ disableRegistration, tokenFromEnv }` |
| `getFullSettings()` | `GET /api/settings/full` | Full settings incl. `isAdmin` (session-derived), retention + `analysisRetentionDays` |
| `updateSettings(body)` | `PUT /api/settings` | Admin-only settings update (types accept `analysisRetentionDays: number \| null`) |
| `generateUploadToken()` | `POST /api/settings/upload-token` | Admin-only — generate a one-time-visible upload token |
| `deleteAnalysis(sessionId, analysisId)` | `DELETE /api/sessions/:id/analyses/:analysisId` | Per-row delete used by the session panel + Settings → Analysis History |
| `exportSessionCsv(sessionId)` | `GET /api/sessions/:sessionId/export/csv` | HEAD pre-check then native `<a>` download |

All functions use `request()` with `credentials: 'include'` for cookie-based
auth. Vehicle types (`Vehicle`, `UpdateVehicle`) and the extended `Session`
type (with `notes`, `vehicleId`, `vehicleName`) are defined in `lib/types.ts`;
`PublicSettings` (anonymous two-field shape) and `Settings` (full, with
optional `isAdmin`) are separate interfaces so callers can't accidentally read
admin-only fields off the public endpoint.

---

## 8. AI Analysis — Prompt Pipeline

The AI analysis feature (`POST /api/sessions/:id/analyze`) streams diagnostic
insights from an OpenAI-compatible LLM. The prompt is built by
`lib/llmPrompt.js`, which after Plan 042 exports five functions instead of the
previous two.

### 8.1 Prompt Assembly Flow

```
POST /api/sessions/:id/analyze
  → controllers/AnalysisController.js
  → lib/llmPrompt.buildAnalysisPrompt(session, settings, telemetrySample, pidKeys)
      ├── buildContext(...)         → vehicle info, session metadata
      ├── computeSummaryStats(...)  → min/max/mean/median per PID
      ├── buildTelemetryCsv(...)    → resampled CSV telemetry data
      └── returns full prompt text → sent to LLM provider
```

### 8.2 Key Functions

| Function | Purpose |
|----------|---------|
| `computeSummaryStats(telemetrySample, pidKeys)` | Pre-computes min, max, mean, median for every PID. Filters null/empty values before numeric conversion to avoid `Number(null) === 0` corruption. Also computes Combined Fuel Trim (STFT + LTFT) per-row. |
| `resampleTelemetry(telemetrySample, maxRows = 80)` | Uniform resampling across the full timeline (replaces the older head/tail slicing approach). Ensures the LLM sees data from start, middle, and end of every drive. |
| `buildTelemetryCsv(telemetrySample, pidKeys)` | Outputs raw CSV instead of Markdown tables (~30% token savings). Removes lat/lon columns. Extracts `HH:mm:ss` via regex. Calls `resampleTelemetry()` internally. |
| `buildContext(session, settings, telemetrySample, pidKeys)` | Builds the vehicle/session context block with cleaner formatting and a "Data points in sample" label. |
| `buildAnalysisPrompt(session, settings, telemetrySample, pidKeys, dataQuality)` | Assembles the complete prompt from all of the above. Includes pre-calculated stats, four diagnostic guardrails, dynamic engine size, and five analysis categories. When a `dataQuality` note is passed (connectivity gaps / backfill bursts detected, Plan 089), a fifth "Data Quality" guardrail is appended; clean sessions get byte-identical prompts. |

### 8.3 Design Notes

- **Statistics pre-computed in JS** — exact min/max/mean/median values are
  calculated server-side, so the LLM does not need to estimate them from sampled
  rows. This eliminates hallucinated figures in the analysis.
- **Uniform resampling** — evenly-spaced rows across the full telemetry range
  (start, middle cruising, end) replace the older approach of keeping only the
  first and last N rows.
- **CSV format** — saves approximately 30% of tokens compared to Markdown tables
  for the same telemetry sample, reducing per-analysis cost.
- **Diagnostic guardrails** — four domain-specific rules encoded in the prompt
  prevent the LLM from flagging normal OBD-II behaviour (negative fuel trims
  within ±10%, A/C idle load, ECU torque management timing, deceleration fuel
  cut-off) as mechanical faults. A fifth, conditional **"Data Quality"**
  guardrail is appended only when connectivity gaps or upload backfill bursts
  are detected (see §8.5); clean sessions keep the byte-identical four-guardrail
  prompt.
- **`lib/pidRegistry.js`** is imported to resolve PID short keys to human-readable
  names and units in both CSV column headers and the stats display.
- **Vehicle profile wins** — the vehicle context block is built from the
  **session's assigned `Vehicle` profile** (`resolveVehicleContext()` reads
  `session.Vehicle` per-field) with the legacy Settings vehicle fields as the
  fallback for unset profile fields; sessions without a Vehicle resolve to the
  legacy fields verbatim, so the pre-profile prompt output is unchanged.

### 8.4 LLM Token Budget & Provider Status (Plan 043)

- **`llmMaxTokens` setting** — the `Settings` singleton gains an INTEGER
  `llmMaxTokens` field (migration `010_add_llm_max_tokens.sql`, NOT NULL,
  default **16384**, validated range **2048–32768**). `PUT /api/settings`
  rejects out-of-range values with `400`; both the GET and PUT responses
  include the field. Covered by `test/settingsValidation.test.js` (7 cases).
- **Provider token budget** — `lib/llmProviders.js` now sends
  `max_tokens: options.maxTokens || settings.llmMaxTokens || 16384` for **all**
  providers (OpenAI, Anthropic, DeepSeek, Ollama, Custom), replacing the old
  hardcoded 8192. Explicit caller options take precedence — e.g. the connection
  test passes `maxTokens: 20` to keep probes cheap, while production analyses
  use the configured budget. This matters for DeepSeek thinking mode, where
  reasoning and content share the same budget.
- **Settings UI** — `AiProviderCard.tsx` adds a general "Max Output Tokens"
  input (min 2048, max 32768, step 1024) with a cost warning, and the provider
  status badge now shows the human-readable provider name plus chips for Model,
  DeepSeek Thinking / Effort, and Max tokens.

### 8.5 AI Analysis Reliability (Plans 087–089)

Reliability hardening for AI analysis on long or backfilled sessions:

- **Token-budget exhaustion is surfaced, not silent** — when a thinking-mode
  model ends the stream with `finish_reason` `length`/`max_tokens` (it spent
  its whole token budget on reasoning and produced no answer, or only a partial
  one), `lib/llmProviders.js` now yields a single `{ type: 'finish', reason }`
  event. The controller streams an SSE `{ type: 'finish', warning }` event that
  the frontend renders as an amber warning banner (`AnalysisPanel.tsx`),
  persists `{ finishReason, reasoningChars, responseChars }` to the
  `Analyses.tokenUsage` JSONB column (no migration), and logs a `console.warn`
  line. Previously the stream simply ended with no answer and no error
  anywhere.
- **Session duration never comes from `createdAt`** — the prompt duration is
  computed from log MIN/MAX timestamps via `formatSessionDuration()`, falling
  back to `Sessions.firstTimestamp`/`lastTimestamp` when logs are missing.
  Backfilled sessions (logs uploaded after the trip ended, e.g. a tablet that
  reconnected at trip end) used to show negative spans like `-1:-1:-24`;
  negative or missing bounds now render as `unknown`.
- **Connectivity gaps are labelled as missing data** — the controller feeds
  `detectBackfillGaps()` the full-resolution log timeline. When it finds a
  connectivity gap (>5 s silence between logs) or a backfill burst (>90 rows in
  one minute), `buildDataQualityNote()` produces the "Data Quality" guardrail
  telling the model the discontinuity is missing (buffered/backfilled) data —
  NOT an engine stall or sensor dropout. Gap-free sessions get byte-identical
  prompts.
- **Remediation** — raise "Max tokens" in Settings (validated 2048–32768) to
  give thinking-mode models more headroom; the earlier mitigation applied on
  the production DB set `llmMaxTokens` to 32768.

---

## 9. Development Tooling

### 9.1 ESLint

The project uses **ESLint 10** (flat config) for backend code with a
project-local `eslint.config.js` configuration (`@eslint/js` recommended presets
+ `globals` 17):

```sh
npm run lint
```

The config (`node` env, `es2022`, `eslint:recommended`) ignores
`apps/frontend/dist/` (Vite build output) and `node_modules/`. Custom rules include:

- `no-unused-vars` set to `warn` (ignoring args prefixed with `_`).
- `no-console` is **off** — the server intentionally uses `console.log`/`console.error`.
- `no-empty` is `error` — empty catch blocks are forbidden.

### 9.2 Pre-commit Hooks (husky + lint-staged)

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

### 9.3 Test Commands

**One-command verification:** run `npm run verify` from the repo root before
every commit — it executes the backend suite + lint, then the frontend suite +
TypeScript check:

```sh
npm run verify   # npm test && npm run lint && (cd apps/frontend && npm test && npx tsc --noEmit)
```

**Backend** (Node built-in test runner):
```sh
npm test              # node --test 'test/*.test.js' + scripts/checkMirrors.js + scripts/checkTestIntegrity.js
npm run test:coverage # runs: c8 node --test + the same check scripts
```

**Frontend** (Vitest):
```sh
cd apps/frontend
npm test         # runs: vitest run
npm run test:watch  # runs: vitest (watch mode)
```

The frontend test stack is **Vitest 5 + jsdom + Testing Library**
(`@testing-library/react`, `@testing-library/user-event`). Component tests that
need a DOM (chart/render tests, the print-flow regression) opt in per file with
`// @vitest-environment jsdom`; pure-logic tests keep the default node
environment. Vitest 5 also lifted the peer-range conflict that previously
forced `--legacy-peer-deps` in CI.

### 9.4 CI Pipeline

A **GitHub Actions** workflow (`.github/workflows/ci.yml`) runs on every push
or pull request to the `development` branch:

- **Backend checks:** `npm ci` → `npm test` → `npm run test:coverage` → `npm run lint`.
- **Frontend checks:** `npm ci` → `npm run lint` (placeholder) → `npm test` (vitest) → `npx tsc --noEmit` (typecheck) → `npm run build`.

CI installs with plain `npm ci` — **no `--legacy-peer-deps`** (the Vitest 5
upgrade removed the need). `CLAUDE.md` / `AGENTS.md` are **not tracked** (they
are gitignored, local-only instruction files) and must not be referenced from
CI or docs as canonical.

The frontend currently has **no lint coverage**: `typescript-eslint` cannot parse
TypeScript ≥7 (its peer range tops out below 6.1 — tracked at
[typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)),
so the stack was removed and `npm run lint` is an explicit placeholder that prints the
reason and exits 0. When typescript-eslint ships TypeScript ≥7 support, re-enable linting
by restoring the flat config, reinstalling `typescript-eslint` / `@eslint/js` / `globals`,
and flipping the script back to `eslint src/`.

The workflow uses `actions/checkout@v7` and `actions/setup-node@v7` with npm
caching and **Node 22** (`node-version: '22'`, matching the `node:22-bookworm-slim`
runtime images). The backend lint step is **enforced** — the previous `continue-on-error: true`
has been removed, so ESLint failures correctly block the build.

### 9.5 Versioning

A **Version Bump** workflow (`.github/workflows/version-bump.yml`) runs on every
push to `master`. It:

1. Analyses commits since the last tag using Conventional Commits heuristics to
   determine the bump type (major / minor / patch).
2. Runs `npm version <bump> --no-git-tag-version` to update `package.json` and
   `package-lock.json`.
3. Commits the result as `chore: release v<version>` and creates an annotated
   tag.
4. Pushes the commit and tag back to `master`.

The workflow guards against self-triggering: it skips when the triggering
commit message starts with `chore: release`.

> **Chaining to Docker builds:** `docker-publish.yml` does **not** rely on the
> `GITHUB_TOKEN` push trigger (pushes made with the default token do not fire
> downstream workflows). Instead it listens for a `workflow_run` event on the
> **Version Bump** workflow completing with `conclusion == 'success'`, and also
> triggers on `v*` tag pushes and manual dispatch. On the `workflow_run` path it
> explicitly checks out `master`, which by then already contains the bumped
> commit — so `/api/version` (which reads the root `package.json` at request
> time in `routes/api.js`) always matches the built image.

Docker images built by `docker-publish.yml` now include **semver tags** in
addition to the SHA and `latest` tags — `v<version>` and `<major>.<minor>` for
pinned deployments.

---

## 10. Known Issues / Follow-up Items

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

- **SSRF guard has a DNS-rebinding TOCTOU (BYOK custom-LLM path).**
  `lib/ssrfGuard.isSafeUrl` resolves the hostname and validates the IP, but
  `lib/llmProviders.js` then calls `fetch(url)` with the **original hostname**
  (via `safeFetch`, which re-validates per redirect hop but not per resolve),
  which re-resolves at connect time (attacker can swap the DNS record to an
  internal IP between check and fetch). The upload webhook fan-out that this
  guard originally protected was **retired (Plan 120)**; the remaining consumer
  is the admin-configured BYOK LLM endpoint, where the threat model is the
  operator's own DNS. **Partially addressed:** the guard validates against a
  resolved IP snapshot, reducing the window, but a full fix (pin the resolved
  IP in the request) is still pending.
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
  formats `duration` into a compact human string (e.g. `"1h 2m 5s"`) via a
  native `formatDuration()` helper that replaces the removed
  `moment-duration-format` dependency; the legacy `addStartEndData` mutation path
  is gone and stale `302`/`addStartEndData` comments were removed from backend +
  frontend.

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
  togglable by the **admin** via `PUT /api/settings` (Plan 099 — see
  "Admin model & analysis retention" below). `GET /api/settings` ORs in the env
  value so the SPA hides the signup form correctly when the env switch is
  active. `UserController.register` enforces both and returns `403` JSON. The
  SPA hides the signup form on `/login` and `/register`; non-admin users of the
  `/settings` page see "Server settings are managed by the administrator." and
  only the per-user cards (Analysis History, Vehicles).
- **Upload API Token UI.** The `/settings` page additionally lets the **admin**
  generate, view (one-time), copy, and clear the upload Bearer token. The token
  is stored in the `Settings` DB row; when the `UPLOAD_API_TOKEN` env var is
  set, the UI reports the token as env-managed and disables the
  generate/clear buttons. `GET /api/settings` returns the public
  `{ disableRegistration, tokenFromEnv }` shape (plus `isAdmin` when
  authenticated); `GET /api/settings/full` exposes `hasUploadApiToken` /
  `tokenFromEnv` to the settings UI, and `POST /api/settings/upload-token`
  (admin-only) generates a new random hex token.
- **Admin model & analysis retention (Plans 099 + 121).** The first registered
  user is promoted to `isAdmin` at register time (migration 017 also backfills
  the lowest-id user on upgraded deployments; `scripts/promote-admin.js
  [--demote] <email>` recovers a mis-promoted account). `PUT /api/settings` and
  `POST /api/settings/upload-token` return `403` for non-admins. Settings gains
  `analysisRetentionDays` (Off/90/120/180/365, migration 019); the app-side
  pruner in `services/analysesRetention.js` sweeps stale `Analysis` rows across
  all users every 6 h. Covered by `test/adminGate.test.js`,
  `test/analysesRetention.test.js`, `test/promoteAdmin.test.js`.
- **PID Decode + Multi-series Overlay Chart.** The ReplayDashboard now features
  a single `OverlayChart.tsx` (replaces the old dual `TimeSeriesChart.tsx`) that
  renders all selected telemetry sources on a shared time axis with
  per-unit-group y-axes. A `PidTogglePanel` lets users search, filter by
  category, and toggle metrics on/off. A collapsible `DecodedMetricsTable` shows
  min/max/avg/last for every PID. The `pidDecode.ts` engine auto-discovers PID
  sources from the `values` JSONB column using embedded Torque metadata
  (  `userFullName*`/`userUnit*`/`defaultUnit*`) with a curated fallback map for
  standard OBD-II PIDs. A pre-existing `RangeError` from spread-into-`Math.max`
  at ~10k frames has also been fixed. The old `TimeSeriesChart.tsx` was deleted.
- ✅ **react-router v8 upgrade (Plans 045 + 047).** The app is on `react-router`
  **8.3.0** (exact pin, imports from the `react-router` package). Plan 045
  migrated from `react-router-dom` 6 (resolving GHSA-wrjc-x8rr-h8h6 and
  GHSA-337j-9hxr-rhxg on the 6.x line), and Plan 047 completed the v8 upgrade,
  which also **resolves GHSA-qwww-vcr4-c8h2** (high, RSC-mode CSRF,
  react-router 7.12.0–8.2.0 — fixed in 8.3.0).

---

## 11. Status

- **Core features complete:** ingestion, TimescaleDB migration, paged telemetry,
  React replay dashboard (overlay chart + imperative Leaflet marker), CSV export,
  session management, BYOK AI analysis.
- **Auth contract resolved and re-reviewed PASS.**
- **Verification:** `npm run verify` from the repo root (backend tests + lint,
  then frontend vitest + `tsc --noEmit`); `npm run build` for the frontend
  bundle. Backend tests run under Node's built-in test runner
  (`test/*.test.js`) plus `scripts/checkMirrors.js` / `scripts/checkTestIntegrity.js`
  checks.
- **Additional features implemented:**
  - Env-tunable upload rate limit with token-based burst exemption (a matching Bearer token bypasses the limiter).
  - Runtime-toggleable registration (`Settings` singleton +
    `DISABLE_REGISTRATION` env kill-switch + admin-only SPA `/settings` toggle).
  - **Upload API Token UI** on the `/settings` page (admin-only generate, view
    once, copy, clear; env override respected).
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
- **Session list pagination + vehicle filtering** — `GET /api/sessions` accepts `limit`, `offset`, and `vehicleId` query params (returns `{ sessions, total, limit, offset }` with `vehicleId`/`vehicleName` per session). The frontend `SessionBrowser` paginates via a "Load More" button and provides a vehicle filter dropdown.
- **Dev tooling:** ESLint 10 (`eslint.config.js`), husky 9 + lint-staged 17
  (pre-commit lint + syntax check), CI pipeline (`.github/workflows/ci.yml`)
  running on push/PR to `development` (Node 22), and automated semver version bump
  (`.github/workflows/version-bump.yml`) on push to `master`.
- **Session Notes (Plan 040)** — `notes` TEXT column on Sessions, `PATCH /api/sessions/notes/:sessionId` endpoint, auto-save textarea in the replay dashboard. Migration: `008_add_session_notes.sql`.
- **Multi-Vehicle Support (Plan 041)** — full `Vehicle` model (name, make, model, year, engineCc, isDefault) with userId FK. Sessions gain nullable `vehicleId` FK. CRUD endpoints at `/api/vehicles/*`, session reassign via `PATCH /api/sessions/:sessionId/vehicle`. UploadController resolves Torque's `v` param to a vehicle. Frontend: `VehicleManager` in Settings with add/edit/delete/default, vehicle filter in session list, vehicle column in session table, reassign dialog in replay dashboard. Migration: `009_add_vehicles.sql`.
- **Improved LLM Analysis Prompt (Plan 042)** — `lib/llmPrompt.js` was rewritten with five exported functions (up from two): `computeSummaryStats()` pre-computes min/max/mean/median per PID with null-safe filtering; `resampleTelemetry()` uniformly resamples across the full timeline replacing head/tail slicing; `buildTelemetryCsv()` outputs token-efficient CSV instead of Markdown tables; `buildContext()` and `buildAnalysisPrompt()` were cleaned up and now include pre-calculated statistical aggregates, four diagnostic guardrails, dynamic engine size injection, and five specific analysis categories. See section 8 for full details.
- **Configurable LLM token limit + provider status (Plan 043)** — `llmMaxTokens` setting (INTEGER, default 16384, range 2048–32768; migration `010_add_llm_max_tokens.sql`) replaces the hardcoded 8192 `max_tokens` across all LLM providers. Settings UI gains a general "Max Output Tokens" input and an expanded provider status display (human-readable provider name, Model, DeepSeek Thinking/Effort, Max tokens). Validation in `UserController.updateSettings` (400 on out-of-range); 7 new cases in `test/settingsValidation.test.js`. See section 8.4.
- **Dependabot fixes (Plan 044)** — `react-router-dom` exact-pinned to 6.30.4 (transitive `react-router` 6.30.4, `@remix-run/router` 1.23.3) and `postcss` 8.5.25, resolving 4 of 6 alerts. The remaining two react-router advisories were then resolved by the v7 migration (Plan 045).
- **react-router v7 migration (Plan 045)** — `react-router-dom` 6.30.4 replaced with `react-router` 7.18.2 (exact pin); all 8 frontend files now import from `react-router`. Resolves GHSA-wrjc-x8rr-h8h6 and GHSA-337j-9hxr-rhxg. The v8 upgrade was completed in Plan 047.
- **Configurable Data Retention Policy (Plan 046)** — `retentionEnabled` (BOOLEAN, default false — opt-in) and `retentionDays` (INTEGER, default 365, range 90–365) on the Settings singleton (migration `011_add_retention_settings.sql`). `PUT /api/settings` validates both fields (400 on non-boolean / non-integer / out-of-range) and applies a TimescaleDB `add_retention_policy`/`remove_retention_policy` on the `Logs` hypertable using a remove-then-add idempotent pattern; the response includes `retentionPolicyApplied`. Frontend Settings page gains a "Data Retention" card (enable Switch + 90/120/180/365-day select, local error state, rollback on save failure). Validation mirrored in `test/settingsValidation.test.js` (10 new cases; suite now **61 tests**).
- **Bleeding-edge dependency upgrade (Plan 047)** — backend (root `package.json`): `joi` 18.2.3, `express-rate-limit` 8.6.2, `pg` 8.22.0, `cors` 2.8.6, `express-session` 1.19.0, `nodemon` 3.1.14, `globals` 17.9.0, `lint-staged` 17.3.0. Frontend: `react`/`react-dom` 19.2.8, `react-router` **8.3.0** (exact pin — replaces `react-router-dom`, resolves GHSA-qwww-vcr4-c8h2), `vite` 8.2.0, `@vitejs/plugin-react` 5.2.0, `typescript` 7.0.2, `tailwindcss` 4.3.3 + `@tailwindcss/vite` 4.3.3, `zustand` 5.0.14, `@tanstack/react-query` 5.101.4, `react-markdown` 10.1.0, `react-leaflet` 5.0.0, `@types/react` 19.2.18, `@types/react-dom` 19.2.4. Infra: both Dockerfiles on `node:22-bookworm-slim`, CI workflows on Node 22, `timescale/timescaledb:2.29.1-pg16` in compose.
- **Tremor replaced with native Tailwind (Plan 049)** — the `@tremor/react` dependency was removed; every Tremor component was reimplemented with plain Tailwind utilities, including a new accessible `Toggle` switch (`components/ui/Toggle.tsx`, sr-only label). `index.css` dropped the Tremor safelist directives and typography tokens. Bundle shrunk ~65 kB; all chunks now <400 kB (largest ~380 kB echarts) via Rolldown `codeSplitting` groups in `vite.config.ts`. See `docs/architecture.md` §3.8.
- **Remaining open issues:** SSRF TOCTOU on the BYOK custom-LLM path (partially
  addressed — the guard validates a resolved-IP snapshot; see section 10 above).
- **Cross-vehicle analysis history** — `GET /api/analyses` lists all analyses across sessions (paginated, optional vehicle filter); `GET /api/analyses/export` streams all analyses as a Markdown file (**keyset-paginated** over `(createdAt, id)`, migration 020, under a dedicated 10/min export limiter — shared with the CSV export); `GET /api/sessions/:sessionId/analyses/:analysisId` returns a single analysis with full response/reasoning. Analyses can be deleted **per row** from the session panel and Settings → Analysis History (`DELETE /api/sessions/:id/analyses/:analysisId`).
- **Analysis retention (Plan 121)** — admin-set `Settings.analysisRetentionDays` (Off/90/120/180/365, migration 019); the app-side pruner `services/analysesRetention.js` (started from `app.js`, 6 h interval, unref'd) sweeps stale `Analysis` rows across all users in bounded id batches. See `docs/architecture.md` §2.13.
- **Perf & correctness hardening (Cycle 7 rollup)** — route-level code splitting (echarts/leaflet only load on the session route), SPA `<Link>` navigation replacing full-reload anchors, vendored Leaflet marker icons (no unpkg), centralized `chartColors.ts` + `layout/brand.tsx`, CSV export HEAD short-circuit, password change bumps `tokenVersion` (kills other sessions), Joi-validated telemetry range (`400` not `500`), timing-safe upload-token comparison, and the analyses keyset export. Frontend tests run on **Vitest 5 + jsdom + Testing Library** (per-file `// @vitest-environment jsdom`).
- **Extracted controller helpers** — `SessionController` now uses `loadOwnedSession()`, `decorateWithSummaries()`, and `aggregateSummaries()` to eliminate duplicate code and the N+1 query pattern.
- **Joi validation schemas** — `lib/validators.js` centralises input validation with Joi schemas for session operations (rename, notes, cut, filter, copy, join, addLocation) and vehicle CRUD (create/update), plus pure validation helpers for LLM settings.
- **v2.0.0 branding & PWA** — product name normalized to **TorqueDash-Next** across `index.html`, Login/Register headings, and the AppShell topbar. `apps/frontend/public/` ships `brand/logo.svg` (interim mark; final owner-supplied SVG is a file-replacement swap), `favicon.svg`, PWA icons (`icon-192.png`, `icon-512.png`, `maskable-512.png`), and `manifest.webmanifest` (name TorqueDash-Next, theme `#009999`). `index.html` links favicon + manifest + theme-color, making the SPA installable to the Android home screen **without a service worker**. Login/Register share one `AuthBranding.tsx` left panel (mark, tagline, 5 USP rows) replacing three duplicated inline panels. AppShell + MobileDrawer render a `v{version}` badge (shared `lib/useVersion.ts`, module-level memoized `/api/version` fetch) and a GitHub link (new tab). See `docs/architecture.md` §3.12.
- **Session Map view + print-to-PDF report (v2.0.0)** — the ReplayDashboard banner gains a `View: Dash | Map` segmented control; Map mode renders a near-fullscreen `GpsTrackMap` (new `className` height prop) with `PlaybackControls`, reusing the zustand playback store and persisting the cursor across toggles (`resolveFrameAtCursor` export; covered by `mapView.test.ts`). The AI button is now "🤖 Run AI Analysis". A new "🖨️ Print / PDF" button produces a print-ready session report: `@media print` CSS forces a light theme incl. dark-utility neutralizers for dark-mode users; `DiagnosticPanels`/`DiagnosticPanel` gain `forceExpanded`; `SessionSummaryCard` shows a Metric\|Min\|Max\|Median table (exported `stats()` helper, covered by `stats.test.ts`); `AnalysisPanel` accepts `printMode` (latest analysis fetched + expanded); printing is disabled in Map view and `printMode` resets via `afterprint` (Safari-safe fallback). See `docs/architecture.md` §3.13.

---

## 12. Alternative Setup Methods

The sections below cover building from source and manual (non-Docker) setup. For
most users, the Docker quick start in the README or the full deployment guide
(`docs/deployment.md`) is sufficient.

### Build from source

```bash
git clone https://github.com/moesix/torque-dash-next.git
cd torque-dash-next

# **Required:** generate session keys (app crashes on startup if missing)
export SESSION_KEYS="$(openssl rand -hex 24)"
# **Required for production (2026 baseline):** upload API token for Torque
# Pro authentication. Alternatively generate from the Settings UI after first
# login (an env-set token overrides and locks the UI).
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

### Express 5 migration (future)

The app uses Express 4.22.x. Express 5 (5.2.x) is the current major. Known
breaking changes relevant here:
- `app.use('*', ...)` wildcard must become `app.use((req, res) => ...)` (no
  path argument) or `app.use('/*splat', ...)`.
- Async error propagation is built-in (no need for try/catch wrappers in
  route handlers — Express 5 catches rejected promises automatically).
- `req.query` returns a plain object (no prototype).

Migration is deferred until integration tests exist (plan 050/069). The
wildcard at `app.js:92` is the only breaking pattern.
