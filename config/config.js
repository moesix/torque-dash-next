let config = {
    port: process.env.PORT || 3000,
    db: {
        uri: process.env.DATABASE_URL || 'postgres://postgres:heslo@localhost:5432/torquedash',
        options: {
            logging: false
        }
    },
    session: {
        // SESSION_KEYS may be a comma-separated string (e.g. in Docker env) or
        // left unset to use the dev defaults. cookie-session expects an array.
        keys: process.env.SESSION_KEYS
            ? process.env.SESSION_KEYS.split(',').map((k) => k.trim()).filter(Boolean)
            : ['6a5w4d65a4wd', 'a65w4d6aw4d89a4', '65f4b8b4szd8']
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
        // Catch-all for every other /api route (reads, session queries).
        global: {
            windowMs: Number(process.env.READ_RATE_LIMIT_WINDOW_MS) || 60000,
            max: Number(process.env.READ_RATE_LIMIT_MAX) || 100
        }
    }
};

module.exports = config;