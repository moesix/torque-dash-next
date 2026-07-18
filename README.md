# torqueDASH-Next

<p align="center">
  <img src="./imgs/hero.svg" width="100%" alt="torqueDASH-Next — Self-hosted OBD-II vehicle telemetry dashboard with live PID data">
</p>

<p align="center">
  <img src="./imgs/tdn-session.jpg" width="100%" alt="torqueDASH-Next dashboard showing GPS route map with color-coded speed and a multi-series telemetry chart">
</p>

A self-hosted dashboard for [Torque Pro](https://torque-bhp.com/) vehicle telemetry. Torque Pro streams live OBD-II data from your car over HTTPS; torqueDASH-Next stores it in a time-series database and renders it in a React dashboard — live gauges, a route map, session replays, and per-session summaries. All data stays on your own server.

## Features

| | |
|---|---|
| **Real-time telemetry playback** | Watch your drive unfold — gauges, chart, and map all move in sync with a single playback cursor. |
| **GPS route map** | Leaflet map with color-coded speed traces and an animated position marker that follows the playback head. |
| **Multi-series overlay chart** | Toggle any combination of PIDs on a shared time axis with per-unit-group y-axes (ECharts + LTTB sampling for large datasets). |
| **CSV export** | Download any session with auto-discovered PID columns — ready for Excel, Google Sheets, or Python notebooks. |
| **BYOK AI analysis** | Connect your own LLM (OpenAI, Anthropic, DeepSeek, Ollama, or any OpenAI-compatible endpoint) for per-session diagnostic insights. |
| **DeepSeek first-class** | `deepseek-v4-flash` / `deepseek-v4-pro` with chain-of-thought Thinking Mode and configurable reasoning effort (High / Max). |
| **PID decode engine** | Auto-discovers every OBD-II parameter from Torque's `values` JSONB — no schema changes when you add new PIDs. |
| **Session management** | Auto-named trips (`Trip DDMMYYYY HH:MM AM/PM`), inline rename, shareable links. |

## Quick start

```bash
# Download the production files
mkdir -p ~/torquedash && cd ~/torquedash
curl -O https://raw.githubusercontent.com/moesix/torque-dash-next/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/moesix/torque-dash-next/master/.env.example

# Create your .env and edit with your settings
cp .env.example .env
nano .env

# Start the stack
docker compose up -d
```

Then open **http://localhost:8080**.

> The app **will not start** without `DATABASE_URL` and `SESSION_KEYS`. Generate them with `openssl rand -base64 24` and `openssl rand -hex 24` respectively. See the full config reference below.

## Connect Torque Pro

In Torque Pro → *Settings → Web Preferences*:

| Setting | Value |
|---------|-------|
| Server URL | `https://<your-host>/api/upload` |
| Email address | The email you registered with |
| Broadcast as HTTP | Header: `Authorization: bearer <UPLOAD_API_TOKEN>` |

After creating all user accounts, disable public registration via the Settings UI or set `DISABLE_REGISTRATION=true` in your `.env` file.

## Screenshots

<details>
<summary><strong>Session replay with overlay chart & GPS track</strong></summary>

<p align="center">
  <img src="./imgs/TDN-session.png" width="100%" alt="Session replay view with overlay chart showing multi-series PID data and a Leaflet GPS map with color-coded speed trace">
</p>

</details>

<details>
<summary><strong>Session list & dashboard overview</strong></summary>

<p align="center">
  <img src="./imgs/tdn-session-list.png" width="100%" alt="Session list with summary cards showing trip duration, distance, and max speed">
</p>

</details>

<details>
<summary><strong>AI-powered session analysis</strong></summary>

<p align="center">
  <img src="./imgs/tdn-ai-analysis.png" width="100%" alt="AI analysis panel showing a diagnostic summary generated from session telemetry data">
</p>

</details>

<details>
<summary><strong>Time-series map view</strong></summary>

<p align="center">
  <img src="./imgs/tdn-timeseries-map.png" width="100%" alt="Combined time-series chart and GPS map view for a telemetry session">
</p>

</details>

<details>
<summary><strong>GPS map view</strong></summary>

<p align="center">
  <img src="./imgs/mapview.png" width="100%" alt="Leaflet GPS map with color-coded speed track">
</p>

</details>

<details>
<summary><strong>Mobile — login</strong></summary>

<p align="center">
  <img src="./imgs/tdn-mobile-login.jpg" width="100%" alt="Mobile login screen">
</p>

</details>

<details>
<summary><strong>Mobile — AI provider settings</strong></summary>

<p align="center">
  <img src="./imgs/tdn-mobile-settings-ai-provider.jpg" width="100%" alt="Mobile AI provider settings panel with DeepSeek selected">
</p>

</details>

<details>
<summary><strong>Mobile — AI analysis</strong></summary>

<p align="center">
  <img src="./imgs/tdn-mobile-ai-analysis.jpg" width="100%" alt="Mobile AI analysis view with streaming diagnostic output">
</p>

</details>

## How it works

| Layer | Stack |
|-------|-------|
| Backend | Node.js + Express 4, Sequelize 6, PostgreSQL / TimescaleDB |
| Frontend | React 18 + Vite + TypeScript, ECharts, Leaflet |
| Deploy | Docker Compose: `db` (TimescaleDB) + `backend` + `frontend` (nginx) |

## Configuration

<details>
<summary>Full environment variables reference</summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | **REQUIRED** | PostgreSQL/TimescaleDB connection string. App crashes on startup if missing. |
| `POSTGRES_PASSWORD` | **REQUIRED** | Database password for Docker deployments. Generate with `openssl rand -base64 24`. |
| `SESSION_KEYS` | **REQUIRED** | Comma-separated express-session secrets. App crashes on startup if missing. |
| `PORT` | `3000` | Backend HTTP port. |
| `NODE_ENV` | _(unset)_ | Set to `production` to skip `sequelize.sync()` (use migrations instead). |
| `COOKIE_SECURE` | `false` | `true` to set `Secure` on session cookies (requires HTTPS). |
| `COOKIE_SAMESITE` | `lax` | `SameSite` policy for session cookies. |
| `CORS_ORIGINS` | _(empty)_ | Comma-separated allowed origins for cross-origin API access. Also serves as the CSRF trust list. |
| `PUBLIC_ORIGIN` | _(unset)_ | Overrides the expected CSRF origin. Set when nginx terminates HTTPS but forwards HTTP to the backend. |
| `UPLOAD_API_TOKEN` | _(unset)_ | If set, uploads require `Authorization: Bearer <token>`. Can also be generated from the Settings UI. |
| `UPLOAD_RATE_LIMIT_MAX` | `600` | Max uploads per window per IP. |
| `UPLOAD_RATE_LIMIT_WINDOW_MS` | `60000` | Upload rate-limit window in milliseconds. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Max login/register requests per window per IP. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `60000` | Auth rate-limit window in milliseconds. |
| `WRITE_RATE_LIMIT_MAX` | `30` | Max authenticated mutations per window per IP. |
| `WRITE_RATE_LIMIT_WINDOW_MS` | `60000` | Write rate-limit window in milliseconds. |
| `READ_RATE_LIMIT_MAX` | `600` | Max requests to all other `/api` routes per window per IP. |
| `READ_RATE_LIMIT_WINDOW_MS` | `60000` | Global `/api` rate-limit window in milliseconds. |
| `DISABLE_REGISTRATION` | _(unset)_ | If `true`, public sign-up is disabled. |
| `LLM_ENCRYPTION_KEY` | _(unset)_ | 64-char hex key for AES-256-GCM encryption of LLM API keys at rest. Generate with `openssl rand -hex 32`. Required for AI analysis feature. |

For detailed deployment instructions, troubleshooting, and reverse proxy setup, see [docs/deployment.md](docs/deployment.md).

</details>

## Security

**Upload authentication:** When `UPLOAD_API_TOKEN` is set, all uploads must include `Authorization: Bearer <token>`. Email alone is no longer sufficient. If upgrading, add your token in Torque Pro → *Settings → Advanced → HTTP Auth Token*.

**Password changes:** Users can change their password via `POST /api/users/change-password`. This validates the current password, enforces a minimum length of 8 characters, and invalidates all other sessions. Bcrypt salt factor is 10.

**Registration control:** After creating accounts, disable public sign-up via the Settings UI toggle or `DISABLE_REGISTRATION=true`.

## Docs

| Document | Description |
|----------|-------------|
| [Deployment guide](docs/deployment.md) | Docker Compose setup, env vars, backup/restore, troubleshooting |
| [Architecture](docs/architecture.md) | System topology, backend internals, data flow, API contract |
| [Development](docs/development.md) | Contributing guide, known issues, manual setup, PID backfill |

## License

MIT — see [LICENSE](./LICENSE). This project is a modernization of, and is grateful for, the original [torque-dash](https://github.com/davekrejci/torque-dash) by David Krejci. Attribution is recorded in [NOTICE](./NOTICE).
