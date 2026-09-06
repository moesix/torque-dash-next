# torqueDASH-Next — Docker Deployment Guide

This guide covers deploying torque-dash-next using Docker Compose with
pre-built images from GitHub Container Registry (GHCR). No repo clone needed.

---

## Prerequisites

- **Docker** 20.10+ and **Docker Compose** v2
- A server with ports `8080` (frontend) and optionally `5432` (database) available
- The Express API is reachable only on the internal compose network; the
  frontend nginx proxies `/api` to it. No host port is published for the
  backend.
- `openssl` for generating secure keys

---

## 1. Download the deployment files

```bash
mkdir -p ~/torquedash && cd ~/torquedash

curl -O https://raw.githubusercontent.com/moesix/torque-dash-next/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/moesix/torque-dash-next/master/.env.example
```

---

## 2. Configure environment variables

```bash
cp .env.example .env
nano .env  # or use your preferred editor
```

### Required variables

The application **will not start** without these:

| Variable | How to generate | Description |
|----------|----------------|-------------|
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` | Database password. Use the same value for all three `POSTGRES_*` vars. |
| `SESSION_KEYS` | `openssl rand -hex 24` | Express session secrets. For key rotation, use comma-separated values. |

### Upload API token (required for production)

As of 2026, token authentication is the required security baseline for Torque
Pro uploads:

- **Set `UPLOAD_API_TOKEN` in `.env` (recommended)** — generate with
  `openssl rand -hex 24`. The env value wins over any Settings-UI token and
  locks the UI while it is set.
- **Or generate from the Settings UI** after first login (shown once). Token
  rotation in the UI is **admin-only** (the first registered user; see §5/§6).

Once a token is configured anywhere, uploads without a matching
`Authorization: Bearer <token>` header return `401`. Email-only ingestion
occurs only when no token is configured at all — a discouraged bootstrap mode
that is insecure for production.

### Optional but recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_ENCRYPTION_KEY` | _(unset)_ | 64-char hex key for AES-256-GCM encryption of LLM API keys at rest. Generate with `openssl rand -hex 32`. Required for AI analysis feature. |
| `COOKIE_SECURE` | `false` | Set to `true` behind a HTTPS reverse proxy (recommended for production). `SameSite` is derived from this variable (`none` when true, else `lax`) — there is no separate `COOKIE_SAMESITE`. Required before entering BYOK LLM keys (see §5). |

### Other variables

See the full reference in [README.md](../README.md#configuration) or the
`.env.example` file for rate limiting, registration control, and cookie
settings.

---

## 3. Start the stack

```bash
docker compose up -d
```

This pulls three images and starts the services:

| Service | Image | Port |
|---------|-------|------|
| `db` | `timescale/timescaledb:2.29.1-pg16` | internal only |
| `backend` | `ghcr.io/moesix/torque-dash-next-backend` | `3000` (internal `expose` only — not published on the host) |
| `frontend` | `ghcr.io/moesix/torque-dash-next-frontend` | `8080` |

Images are tagged with:
- `latest` — most recent build from `master`.
- `sha-<hash>` — immutable per-commit identifier.
- `v<semver>` — pinned release version (e.g. `v1.2.3`).
- `<major>.<minor>` — minor-version channel (e.g. `1.2`).

The database waits for the healthcheck (`pg_isready`) before the backend
starts. The backend waits for the database to be healthy.

---

## 4. CI/CD Pipeline

The project uses three GitHub Actions workflows that form a continuous delivery
chain:

| Workflow | Trigger | Actions |
|----------|---------|---------|
| **CI** (`.github/workflows/ci.yml`) | Push / PR to `development` | Runs `npm test` + `npm run lint` (backend), `tsc --noEmit` + `npm run build` (frontend) |
| **Version Bump** (`.github/workflows/version-bump.yml`) | Push to `master` | Analyses commits since last tag, bumps `package.json` semver, commits and tags as `chore: release v<version>` |
| **Docker Publish** (`.github/workflows/docker-publish.yml`) | Push to `master` | Builds and pushes `backend` and `frontend` images to GHCR with SHA, `latest`, and semver tags |

### Workflow chain

1. A PR merges into `development` → **CI** validates the code.
2. `development` is merged into `master` → **Version Bump** increments the
   semver, commits, and pushes a new tag.
3. The version bump push to `master` triggers **Docker Publish**, which builds
   images and pushes them to GHCR with the new version tags.

> **PAT requirement:** pushes made with the default `GITHUB_TOKEN` do **not**
> trigger downstream workflows. The version-bump workflow includes instructions
> to configure a personal access token (`secrets.GH_PAT`) with `contents:write`
> scope so the version bump commit triggers the Docker publish workflow. Without
> this, the version bump and Docker build are decoupled and must be triggered
> manually.

---

## 5. First-time setup

1. Open **http://localhost:8080** in your browser.
2. Register the first account at the sign-up page — **this account becomes the
   site admin** (`isAdmin`), the only account that can change server settings.
3. Sign in with your credentials.
4. Configure the upload API token — **required for production** (see step 2's
   "Upload API token" section): either set `UPLOAD_API_TOKEN` in `.env` before
   launching, or generate one from **Settings** now (admin only — which the
   first account is).
5. Configure Torque Pro (see below).

### Configure Torque Pro

In Torque Pro → *Settings → Web Preferences*:

- **Server URL:** `https://<your-host>/api/upload`
- **Email address:** the email you registered with
- **Broadcast as HTTP** with header: `Authorization: bearer <UPLOAD_API_TOKEN>`

### Disable public registration

After creating all user accounts, disable public sign-up via the **Settings**
UI toggle (admin only) or set `DISABLE_REGISTRATION=true` in your `.env` file.

### AI analysis (optional)

torqueDASH-Next supports BYOK (Bring Your Own Key) AI-powered session analysis.
Go to **Settings** to configure an LLM provider (OpenAI, Anthropic, DeepSeek,
Ollama, or any OpenAI-compatible endpoint). Set `LLM_ENCRYPTION_KEY` in your
`.env` to encrypt API keys at rest.

> **LLM keys are admin-managed and need TLS.** Only the admin account (the
> first registered user; see §6) can configure the LLM provider. **Set
> `COOKIE_SECURE=true` / terminate TLS at the edge before using BYOK LLM
> keys** — the keys are submitted over the browser connection and would
> otherwise travel over plain HTTP. Custom (OpenAI-compatible) endpoints are
> SSRF-checked server-side before any request.

---

## 6. Upgrading

```bash
cd ~/torquedash  # or wherever you deployed

# Pull the latest images
docker compose pull

# Recreate containers with the new images
docker compose up -d
```

Data is persisted in the `pgdata` Docker volume — it survives container
recreations. The TimescaleDB migration runs automatically on startup if needed.

### Admin account on upgrade

On an **upgraded** deployment (users created before migration `017`), the
migration promotes the **lowest-id user** to admin (`isAdmin = true`), because
that account predates the first-registered-user bootstrap rule. On a
multi-user deployment the operator may **not** be that account — without admin
access the token rotation, LLM, registration and retention controls are
unreachable.

Verify who was promoted after upgrading:

```bash
docker compose exec db \
  psql -U torquedash -d torquedash -c 'SELECT id, email, "isAdmin" FROM "Users";'
```

To promote (or demote) a specific account, run the recovery script on the
backend host (reads `DATABASE_URL` from your environment, like `migrate.js`):

```bash
# Promote the operator's account to admin
node scripts/promote-admin.js operator@example.com

# Remove admin from an account
node scripts/promote-admin.js --demote someone@example.com
```

The script prints the affected user's `id` + `email`, is idempotent
(re-running is a no-op), and exits non-zero with a clear message if no user
matches.

### ⚠️ TimescaleDB extension upgrade (2.15.3 → 2.29.1)

The TimescaleDB **extension does NOT auto-upgrade with the container image**.
Pulling `timescale/timescaledb:2.29.1-pg16` and recreating the `db` container
updates the TimescaleDB binaries, but the `timescaledb` extension inside your
existing database stays on the old version (2.15.3) until an operator runs the
SQL upgrade. Until then, newer extension features may be unavailable and
`\dx timescaledb` still reports the old version.

After the upgrade deploy, run this once per database (the `db` service user in
compose is a superuser):

```bash
# Inside the db container, as the compose database user:
docker compose exec db \
  psql -U torquedash -d torquedash -c "ALTER EXTENSION timescaledb UPDATE;"
```

Verify the new version:

```bash
docker compose exec db \
  psql -U torquedash -d torquedash -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';"
# expect: 2.29.1
```

Notes:

- `ALTER EXTENSION timescaledb UPDATE;` upgrades the extension in place without
  downtime; existing hypertables and policies (compression, retention) are
  preserved and upgraded automatically.
- The default compose user is `torquedash` — substitute your `POSTGRES_USER` /
  `POSTGRES_DB` if you changed them in `.env`.
- Fresh deployments (no pre-existing `pgdata`) initialize the extension at the
  image version on first start and need no manual step.

---

## 7. Backup and restore

### Backup the database

```bash
docker compose exec db \
  pg_dump -U torquedash torquedash > backup_$(date +%Y%m%d).sql
```

### Restore from backup

```bash
cat backup_20260717.sql | docker compose exec -T db \
  psql -U torquedash torquedash
```

---

## 8. Troubleshooting

### App won't start

- **"SESSION_KEYS must be set"** or **"POSTGRES_PASSWORD must be set"** — the
  app requires these values. Check your `.env` file.
- **Database not ready** — the backend waits for `pg_isready` to pass. If the
  database is slow to start, give it a moment and check
  `docker compose logs db`.

### Can't connect to the frontend

- Verify the frontend container is running:
  `docker compose ps`
- Check nginx logs:
  `docker compose logs frontend`
- Ensure port `8080` is not blocked by a firewall.

### Uploads failing with 401

- With `UPLOAD_API_TOKEN` configured (in `.env` or generated from the Settings
  UI), Torque Pro must send the matching `Authorization: bearer <token>` header.
- A token set in `.env` overrides any Settings-UI token and locks
  the UI — make sure Torque Pro is configured with the env value.
- Check the backend logs:
  `docker compose logs backend`

### Viewing logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f backend
docker compose logs -f db
docker compose logs -f frontend
```

### Stopping the stack

```bash
docker compose down
```

Add `-v` to also remove the database volume (**data will be lost**):

```bash
docker compose down -v
```

---

## 9. Architecture overview

```
┌────────────┐     ┌──────────────────┐     ┌──────────────────────────┐
│  db        │◀────│  backend (Express)│◀────│  frontend / nginx        │
│ PostgreSQL +│     │  :3000           │     │  :8080                   │
│ TimescaleDB │     │  /api + /api/upload│   │  serves SPA build,        │
└────────────┘     └──────────────────┘     │  proxies /api -> backend  │
   internal net        internal net         └──────────────────────────┘
                                            edge / public
```

- **db** — TimescaleDB 2.29 on PostgreSQL 16. Hypertable with compression (7-day
  policy). Data in `pgdata` volume.
- **backend** — Node.js/Express API. Runs as non-root user (`appuser`).
  Handles telemetry ingestion, auth, session management. Reachable only on the
  internal compose network — no host port is published; the frontend nginx
  proxies `/api` to it.
- **frontend** — Unprivileged Nginx serving the React SPA. Proxies `/api`
  requests to the backend.
