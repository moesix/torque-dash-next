/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * Production-grade alternative: `express-rate-limit` (recommended for multi-instance
 * deployments, since this version keeps state only in the current process). Kept
 * dependency-free per Tier-2 build constraints. Keyed by req.ip.
 */
function rateLimit({ windowMs, max }) {
    const hits = new Map(); // ip -> { count, resetAt }

    // Periodic cleanup of expired windows to bound memory.
    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [ip, rec] of hits) {
            if (rec.resetAt <= now) hits.delete(ip);
        }
    }, windowMs);
    cleanup.unref();

    return function (req, res, next) {
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const now = Date.now();
        let rec = hits.get(ip);
        if (!rec || rec.resetAt <= now) {
            rec = { count: 0, resetAt: now + windowMs };
            hits.set(ip, rec);
        }
        rec.count += 1;
        if (rec.count > max) {
            return res.status(429).json({ error: 'Too many requests, please slow down.' });
        }
        next();
    };
}

module.exports = rateLimit;
