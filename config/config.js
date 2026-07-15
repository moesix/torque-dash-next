let config = {
    port: process.env.PORT || 3000,
    db: {
        uri: (() => {
            if (!process.env.DATABASE_URL) {
                throw new Error(
                    'DATABASE_URL environment variable is required.\n' +
                    'Example: postgres://user:password@localhost:5432/torquedash'
                );
            }
            return process.env.DATABASE_URL;
        })(),
        options: {
            logging: false
        }
    },
    session: {
        keys: (() => {
            if (!process.env.SESSION_KEYS) {
                throw new Error(
                    'SESSION_KEYS environment variable is required.\n' +
                    'Generate with: openssl rand -hex 24\n' +
                    'For multiple keys (rotation): openssl rand -hex 24,openssl rand -hex 24'
                );
            }
            const keys = process.env.SESSION_KEYS.split(',').map(k => k.trim()).filter(Boolean);
            if (keys.length === 0) {
                throw new Error('SESSION_KEYS must contain at least one key');
            }
            const placeholders = ['please-change-this-in-production', 'change-me', 'secret', 'changeme'];
            if (keys.some(k => placeholders.includes(k.toLowerCase()))) {
                throw new Error(
                    'SESSION_KEYS contains a placeholder value.\n' +
                    'Generate real keys with: openssl rand -hex 24'
                );
            }
            return keys;
        })()
    },
    // Tiered rate limits (express-rate-limit). All windows/caps are env-tunable.
    // Keyed on req.ip (app.set('trust proxy', 1) makes this the real client IP
    // behind Cloudflare/nginx). Threat model here is volumetric abuse and
    // TimescaleDB query cost for a handful of personal users — not credential
    // stuffing — so caps are generous but bound worst-case load.
    rateLimits: {
        // Auth endpoints (login + register): slow brute-force / spray.
        auth: {
            windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 60000,
            max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 10
        },
        // Torque ingestion (GET /upload): bursts on reconnect/backlog flush.
        upload: {
            windowMs: Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS) || 60000,
            max: Number(process.env.UPLOAD_RATE_LIMIT_MAX) || 600
        },
        // Authenticated mutations (PUT settings/forwardurls): bound write churn.
        write: {
            windowMs: Number(process.env.WRITE_RATE_LIMIT_WINDOW_MS) || 60000,
            max: Number(process.env.WRITE_RATE_LIMIT_MAX) || 30
        },
        // Catch-all for every other /api route (reads, session queries). Set
        // generously: the SPA polls the paged telemetry endpoint heavily during
        // replay, so a low cap would 429 a single legitimate user.
        global: {
            windowMs: Number(process.env.READ_RATE_LIMIT_WINDOW_MS) || 60000,
            max: Number(process.env.READ_RATE_LIMIT_MAX) || 600
        }
    }
};

module.exports = config;