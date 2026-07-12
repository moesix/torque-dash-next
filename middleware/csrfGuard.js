'use strict';

// CSRF defense for the JSON API.
//
// We deliberately do NOT use `csurf`: it is archived/unmaintained by the Express
// team and would reintroduce supply-chain surface we just removed during the
// dependency triage. For a JSON SPA, the OWASP-recommended equivalent is to
// verify that every state-changing request is same-origin ("verify origin with
// standard headers"):
//
//   - A browser CSRF attack auto-attaches the session cookie but MUST also send
//     an `Origin` header reflecting the attacker's site.
//   - We reject any unsafe request whose `Origin` is present and is neither
//     same-origin (matching the request Host) nor in the trusted CORS_ORIGINS
//     allowlist.
//   - Non-browser clients (curl, the Torque native app) send NO `Origin` and
//     cannot ride a browser session cookie, so they pass through.
//
// This complements the existing SameSite=Lax cookie (which already blocks
// cross-site cookie attachment in the default config) and the empty-by-default
// CORS allowlist — defense in depth for the production SameSite=None case.
//
// CodeQL's js/missing-csrf-protection query only recognizes dedicated CSRF
// libraries, so the alert is suppressed at the cookie-session registration in
// app.js with this justification.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfGuard(allowedOrigins) {
    const allow = new Set(allowedOrigins || []);

    return function (req, res, next) {
        // Safe methods do not change state and are not CSRF-relevant.
        if (SAFE_METHODS.has(req.method)) return next();

        const origin = req.headers.origin;
        // No Origin header => non-browser client (curl / Torque app). It cannot
        // exploit a browser session, so allow it through.
        if (!origin) return next();

        // Same-origin: compare the Origin host to the request Host.
        const host = (req.headers.host || '').split(':')[0];
        try {
            const originHost = new URL(origin).hostname;
            if (originHost === host) return next();
        } catch {
            return res.status(403).json({ error: 'Cross-origin request forbidden.' });
        }

        // Trusted, explicitly allowlisted SPA origin.
        if (allow.has(origin)) return next();

        return res.status(403).json({ error: 'Cross-origin request forbidden.' });
    };
}

module.exports = csrfGuard;
