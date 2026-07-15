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
- **React dashboard** — live vehicle view, route map (OpenStreetMap tiles, no API key), replay with a multi-series PID overlay chart (toggleable metric panel, collapsible stats table, y-axis capped at 4 axes total to prevent overcrowding), a session summary card with live SVG ring gauges (RPM, Coolant, Speed) that update as the playback cursor moves, and a settings page with upload API token management. Full dark mode support, mobile-responsive layout with a slide-out navigation drawer, and loading skeletons throughout.
- **Session auto-naming** — new sessions are automatically named `Trip DDMMYYYY HH:MM AM/PM` on first upload.
- **Inline session rename** — rename sessions directly from the session table via an inline edit button (pencil icon, Enter/Escape/blur handling).
- **PID decode engine** — auto-discovers all OBD-II parameters from Torque's JSONB `values` column using embedded metadata (`userFullName*`/`userUnit*`) and a curated fallback map; no schema changes needed for new PIDs. Torque stores OBD‑II PIDs as hex keys without leading zeros (e.g. `kc` for RPM/PID 0x0C, `kd` for Speed/PID 0x0D).
- **Controlled ingestion** — email-gated uploads with an optional API-token
  (`Bearer`) bypass for Torque Pro over HTTPS; token can be generated from
  the Settings UI or set via the `UPLOAD_API_TOKEN` environment variable.
- **Operational guards** — rate-limited upload endpoint, togglable open
  registration, and environment-driven configuration.
- **Design system** — CSS custom properties for colors, typography, and borders; Google Fonts (Space Grotesk + Martian Mono); Tailwind v4 configured via CSS-first `@theme` block (custom font-family stacks, semantic color tokens, and Tremor design tokens all in `index.css`); PostCSS replaced by the `@tailwindcss/vite` plugin.
- **Dark mode** — system preference detection with manual override, persisted to localStorage, toggled via a sun/moon button in the app header. All components carry `dark:` Tailwind variants (class-based toggling via `@custom-variant dark` in `index.css`).
- **Mobile responsive** — responsive layout with a hamburger-triggered slide-out drawer (MobileDrawer), touch-friendly 44px minimum tap targets, and fluid chart sizing that adapts to viewport width.
- **Accessibility** — focus-visible indicators, skip-to-content link, form validation with aria-invalid/aria-describedby, keyboard navigation on interactive elements, and aria-live regions for dynamic content.
- **Micro-interactions** — fade-in/slide-up page transitions keyed on the active route, staggered reveal with animation-delay on dashboard sections, card-hover effects on table rows. Respects `prefers-reduced-motion`.

## Architecture

| Layer     | Stack                                                        |
|-----------|-------------------------------------------------------------|
| Backend   | Node.js + Express 4, Sequelize 5, PostgreSQL / TimescaleDB |
| Frontend  | React 18 + Vite + TypeScript, ECharts, Leaflet, pidDecode  |
| Deploy    | Docker Compose: `db` (TimescaleDB) + `backend` + `frontend` (nginx) |

## Quick start (Pre-built images — easiest)

No clone needed! Just download the files and configure:

```bash
# Download the production files
curl -O https://raw.githubusercontent.com/moesix/torque-dash-next/master/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/moesix/torque-dash-next/master/.env.example

# Create your .env file and edit with your settings
cp .env.example .env
nano .env  # or your preferred editor

# Start the stack
docker compose -f docker-compose.prod.yml up -d
```

Then open **http://localhost:8080**.

### Required configuration

Edit your `.env` file with these essential settings. The app **will not start** without `DATABASE_URL` and `SESSION_KEYS`.

| Variable | Description | How to generate |
|----------|-------------|-----------------|
| `DATABASE_URL` | PostgreSQL/TimescaleDB connection string (REQUIRED) | `postgres://user:password@host:5432/torquedash` |
| `POSTGRES_PASSWORD` | Database password for Docker deployments (REQUIRED) | `openssl rand -base64 24` |
| `SESSION_KEYS` | Express session secrets (REQUIRED) | `openssl rand -hex 24` |
| `UPLOAD_API_TOKEN` | Bearer token for Torque Pro — **required when configured** | `openssl rand -hex 24` or generate in Settings UI |
| `COOKIE_SECURE` | Set to `true` behind HTTPS | — |

### Security tip

After creating all user accounts, disable public registration to prevent unauthorized sign-ups:

- **Via Settings UI:** Toggle "Disable registration" in the Settings page
- **Via environment variable:** Set `DISABLE_REGISTRATION=true` in your `.env` file

### Configure Torque Pro

In Torque Pro → *Settings → Web Preferences*:
- **Server URL:** `https://<your-host>/api/upload`
- **Email address:** the email you registered with
- **Broadcast as HTTP** with header: `Authorization: bearer <UPLOAD_API_TOKEN>`

Images are published to [GitHub Container Registry](https://ghcr.io/moesix/torque-dash-next) on every merge to master. Data is persisted in the `pgdata` volume.

## Quick start (Build from source)

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

## Manual setup (without Docker)

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
- **Email address:** the email you registered with (used to link uploads to your account)
- **Broadcast as HTTP** with header `Authorization: bearer <UPLOAD_API_TOKEN>` —
  required for authentication when the token is configured. You can generate the
  token from the Settings page in the web UI, or set it via the `UPLOAD_API_TOKEN`
  environment variable.

## Breaking Change: Upload Authentication

As of the July 2026 security update, when `UPLOAD_API_TOKEN` is configured, **all uploads must include the bearer token** in the `Authorization` header. Email alone is no longer sufficient authentication — this closes a security gap where a valid email could be used to inject data.

**If you are upgrading from an older version and already have `UPLOAD_API_TOKEN` set:**

1. In Torque Pro → *Settings → Advanced → HTTP Auth Token*, enter your upload token
2. Torque Pro will automatically add `Authorization: Bearer <token>` to every upload
3. Uploads that lack the token will receive **401 Unauthorized**

**If you do NOT have `UPLOAD_API_TOKEN` set:** there is no change — the email-gated flow still works (though configuring a token is strongly recommended).

> **Quick test:** set `UPLOAD_API_TOKEN` in `.env`, restart the stack, then try an upload without the header → you should get a 401 response.

## Password Change Endpoint

Authenticated users can change their password via:

```
POST /api/users/change-password
```

**Body:** `{ "currentPassword": "...", "newPassword": "..." }`

**Response:** `{ "ok": true, "message": "Password changed. Other sessions have been invalidated." }`

The endpoint validates the current password, enforces a minimum length of 8 characters, and **regenerates the session** — all other sessions for this user are invalidated on change. The password salt factor has been increased to 10 (OWASP-recommended minimum).

## Configuration (environment variables)

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

## License

MIT — see [LICENSE](./LICENSE). This project is a modernization of, and is
grateful for, the original [torque-dash](https://github.com/davekrejci/torque-dash)
by David Krejci. Attribution is recorded in [NOTICE](./NOTICE).
