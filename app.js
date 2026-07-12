// Add module dependencies
const express = require('express');
const app = express();
// Trust one proxy hop (Nginx / Vite dev proxy) so req.ip reflects the real
// client IP from X-Forwarded-For. Required for the express-rate-limit tiers in
// routes/api.js, which key buckets on req.ip — otherwise every client behind
// the proxy collapses into a single shared bucket.
// CSRF protection is provided by middleware/csrfGuard.js — a same-origin Origin
// check on all state-changing /api requests (OWASP-recommended for JSON SPAs).
// This avoids the unmaintained `csurf` dependency. The js/missing-csrf-protection
// CodeQL alert is suppressed on the cookie-session registration below.
app.set('trust proxy', 1);
const cors = require('cors');
// const logger = require('morgan');
const { sequelize } = require('./models');
const config = require('./config/config');
const flash = require('connect-flash');
const session = require('cookie-session');
const passport = require('passport');
const csrfGuard = require('./middleware/csrfGuard');
const User = require('./models').User;
require('./config/passport')(passport);

// CORS: explicit allowlist + credentials, scoped to /api only.
// The Torque native app hitting /api/upload sends no Origin/cookie, so this is
// harmless to it. Configure with CORS_ORIGINS=https://app.example.com,https://...
const corsOpts = {
    origin: (process.env.CORS_ORIGINS || '').split(',').filter(Boolean),
    credentials: true
};

// Configure middleware
app.use('/api', cors(corsOpts));
// CSRF guard: same-origin Origin check on state-changing /api requests. See
// middleware/csrfGuard.js. Reuses the CORS allowlist as the trusted-origin set.
app.use('/api', csrfGuard(corsOpts.origin));
app.use(express.urlencoded({ extended: true }));
// app.use(logger('combined'));
app.use(session({ // codeql[js/missing-csrf-protection] mitigated by same-origin Origin check in middleware/csrfGuard.js
    keys: config.session.keys,
    maxAge: 24 * 60 * 60 * 1000,
    cookie: {
        httpOnly: true,
        // Cross-origin SPA auth requires sameSite:'none' + secure. Gate by env so
        // local/dev (same-origin, Lax) keeps working without HTTPS.
        sameSite: process.env.COOKIE_SECURE === 'true' ? 'none' : 'lax',
        secure: process.env.COOKIE_SECURE === 'true'
    }
}));
app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
    res.locals.success = req.flash('success');
    res.locals.error = req.flash('error');
    next();
});

// Health probe (no auth)
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// Parse JSON bodies for /api (SPA + Torque native clients). Placed BEFORE the
// api router so req.body is populated for every JSON endpoint. Legacy/native
// Torque form posts still work via the express.urlencoded() below/above.
app.use('/api', express.json({ limit: '1mb' }));
app.use('/api', require('./routes/api.js'));
// JSON 404 for any unmatched route (the SPA handles its own not-found UI).
app.use('*', (req, res) => res.status(404).json({ error: 'Not found' }));

// Connect to database and (non-prod) sync models.
// In production, migrations in infra/timescale/log_hypertable.sql are the source
// of truth — auto-syncing would bypass the hypertable migration.
async function bootstrap() {
    try {
        if (process.env.NODE_ENV !== 'production') {
            await sequelize.sync();
            console.log('Connection to database successfully established');
        } else {
            console.log('Production: skipping sequelize.sync() (migrations are source of truth).');
        }
        // Start server
        app.listen(config.port, () => console.log(`Listening on port ${config.port}`));
    } catch (err) {
        console.log('Error connecting to the database:', err.message);
    }
}

bootstrap();
