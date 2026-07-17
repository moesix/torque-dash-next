# TorqueDashNext — Docker Deployment Guide

This guide covers deploying torque-dash-next using Docker Compose with
pre-built images from GitHub Container Registry (GHCR). No repo clone needed.

---

## Prerequisites

- **Docker** 20.10+ and **Docker Compose** v2
- A server with ports `8080` (frontend) and optionally `5432` (database) available
- `openssl` for generating secure keys

---

## 1. Download the deployment files

```bash
mkdir -p ~/torquedash && cd ~/torquedash

curl -O https://raw.githubusercontent.com/moesix/torque-dash-next/master/docker-compose.prod.yml
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

### Optional but recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `UPLOAD_API_TOKEN` | _(unset)_ | Bearer token for Torque Pro uploads. Generate with `openssl rand -hex 24`, or generate from the Settings UI after first login. When set, uploads **require** this token. |
| `COOKIE_SECURE` | `false` | Set to `true` behind a HTTPS reverse proxy (recommended for production). |

### Other variables

See the full reference in [README.md](../README.md#configuration) or the
`.env.example` file for rate limiting, registration control, and cookie
settings.

---

## 3. Start the stack

```bash
docker compose -f docker-compose.prod.yml up -d
```

This pulls three images and starts the services:

| Service | Image | Port |
|---------|-------|------|
| `db` | `timescale/timescaledb:2.15.3-pg16` | internal only |
| `backend` | `ghcr.io/moesix/torque-dash-next-backend:latest` | `3000` |
| `frontend` | `ghcr.io/moesix/torque-dash-next-frontend:latest` | `8080` |

The database waits for the healthcheck (`pg_isready`) before the backend
starts. The backend waits for the database to be healthy.

---

## 4. First-time setup

1. Open **http://localhost:8080** in your browser.
2. Register the first account at the sign-up page.
3. Sign in with your credentials.
4. (Optional) Go to **Settings** to generate an upload API token if you didn't
   set one in `.env`.
5. Configure Torque Pro (see below).

### Configure Torque Pro

In Torque Pro → *Settings → Web Preferences*:

- **Server URL:** `https://<your-host>/api/upload`
- **Email address:** the email you registered with
- **Broadcast as HTTP** with header: `Authorization: bearer <UPLOAD_API_TOKEN>`

### Disable public registration

After creating all user accounts, disable public sign-up via the **Settings**
UI toggle or set `DISABLE_REGISTRATION=true` in your `.env` file.

---

## 5. Upgrading

```bash
cd ~/torquedash  # or wherever you deployed

# Pull the latest images
docker compose -f docker-compose.prod.yml pull

# Recreate containers with the new images
docker compose -f docker-compose.prod.yml up -d
```

Data is persisted in the `pgdata` Docker volume — it survives container
recreations. The TimescaleDB migration runs automatically on startup if needed.

---

## 6. Backup and restore

### Backup the database

```bash
docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U torquedash torquedash > backup_$(date +%Y%m%d).sql
```

### Restore from backup

```bash
cat backup_20260717.sql | docker compose -f docker-compose.prod.yml exec -T db \
  psql -U torquedash torquedash
```

---

## 7. Troubleshooting

### App won't start

- **"SESSION_KEYS must be set"** or **"POSTGRES_PASSWORD must be set"** — the
  app requires these values. Check your `.env` file.
- **Database not ready** — the backend waits for `pg_isready` to pass. If the
  database is slow to start, give it a moment and check
  `docker compose -f docker-compose.prod.yml logs db`.

### Can't connect to the frontend

- Verify the frontend container is running:
  `docker compose -f docker-compose.prod.yml ps`
- Check nginx logs:
  `docker compose -f docker-compose.prod.yml logs frontend`
- Ensure port `8080` is not blocked by a firewall.

### Uploads failing with 401

- If `UPLOAD_API_TOKEN` is set in `.env` or generated from the Settings UI,
  Torque Pro must send the matching `Authorization: bearer <token>` header.
- Check the backend logs:
  `docker compose -f docker-compose.prod.yml logs backend`

### Viewing logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Specific service
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f db
docker compose -f docker-compose.prod.yml logs -f frontend
```

### Stopping the stack

```bash
docker compose -f docker-compose.prod.yml down
```

Add `-v` to also remove the database volume (**data will be lost**):

```bash
docker compose -f docker-compose.prod.yml down -v
```

---

## 8. Architecture overview

```
┌────────────┐     ┌──────────────────┐     ┌──────────────────────────┐
│  db        │◀────│  backend (Express)│◀────│  frontend / nginx        │
│ PostgreSQL +│     │  :3000           │     │  :8080                   │
│ TimescaleDB │     │  /api + /api/upload│   │  serves SPA build,        │
└────────────┘     └──────────────────┘     │  proxies /api -> backend  │
   internal net        internal net         └──────────────────────────┘
                                            edge / public
```

- **db** — TimescaleDB on PostgreSQL 16. Hypertable with compression (7-day
  policy). Data in `pgdata` volume.
- **backend** — Node.js/Express API. Runs as non-root user (`appuser`).
  Handles telemetry ingestion, auth, session management.
- **frontend** — Unprivileged Nginx serving the React SPA. Proxies `/api`
  requests to the backend.
