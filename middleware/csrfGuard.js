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
//     an `Origin` header reflecting the attacker's site. We compare the full
//     origin (scheme + host + port) against our own and against the trusted
//     CORS_ORIGINS allowlist.
//   - No `Origin` header typically means a non-browser client (curl, the Torque
//     native app). These cannot ride a browser session cookie, so they are not a
//     CSRF vector for modern browsers (which always send Origin on unsafe
//     cross-site requests). As defense-in-depth for the production
//     SameSite=None cookie case, if a `Referer` is supplied it must also be
//     same-origin / trusted.
//   - Non-browser clients that do send a `Referer` (e.g. some scripted tools)
//     are validated by it; those sending neither pass through.
//
// This complements the existing SameSite=Lax cookie (which already blocks
// cross-site cookie attachment in the default config) and the empty-by-default
// CORS allowlist.
//
// CodeQL's js/missing-csrf-protection query only recognizes dedicated CSRF
// libraries, so the alert is suppressed at the express-session registration in
// app.js with this justification.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfGuard({ allowedOrigins = [], publicOrigin } = {}) {
    const allow = new Set(allowedOrigins || []);

    return function (req, res, next) {
        // Safe methods do not change state and are not CSRF-relevant.
        if (SAFE_METHODS.has(req.method)) return next();

        // When publicOrigin is provided, use it as the expected origin instead of
        // reconstructing from req.protocol + req.headers.host. This handles the
        // case where nginx forwards X-Forwarded-Proto as http while the real
        // browser-visible scheme is https (e.g. behind Cloudflare).
        const expected = publicOrigin
            ? new URL(publicOrigin.replace(/\/+$/, '')).origin
            : `${req.protocol}://${req.headers.host}`;
        const deny = () =>
            res.status(403).json({ error: 'Cross-origin request forbidden.' });

        const origin = req.headers.origin;
        if (origin) {
            // Origin present: must be same-origin or an explicitly trusted SPA
            // origin. Compare the full origin per OWASP.
            let ok = false;
            try {
                ok = new URL(origin).origin === expected || allow.has(origin);
            } catch {
                return deny();
            }
            return ok ? next() : deny();
        }

        // No Origin header: typically a non-browser client (curl, the Torque
        // native app). Not a CSRF vector for modern browsers. As defense-in-depth
        // for SameSite=None, if a Referer is supplied it must be same-origin /
        // trusted.
        const referer = req.headers.referer;
        if (referer) {
            try {
                const refOrigin = new URL(referer).origin;
                if (refOrigin !== expected && !allow.has(refOrigin)) return deny();
            } catch {
                return deny();
            }
        }
        return next();
    };
}

module.exports = csrfGuard;
