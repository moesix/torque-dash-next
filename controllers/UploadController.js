const User = require('../models').User;
const Session = require('../models').Session;
const _ = require('lodash');
const userCache = require('../lib/userCache');
const ssrfGuard = require('../lib/ssrfGuard');
const ingestBuffer = require('../services/ingestBuffer');

// Resolve an email to a User, using the positive + negative TTL cache.
// Returns the user, or null if unknown (unknown emails are cached as negatives).
async function resolveUser(eml) {
    if (!eml) return null;
    const cached = userCache.get(eml);
    if (cached !== undefined) return cached; // may be null (negative cache hit)
    const user = await User.findOne({ where: { email: eml } });
    userCache.set(eml, user || null); // negative-cache a miss as null
    return user || null;
}

class UploadController {
    static async processUpload(req, res) {
        try {
            let { eml, session, time } = req.query;
            let lon = req.query.kff1005;
            let lat = req.query.kff1006;

            // Torque may send repeated query params as arrays
            if (Array.isArray(lon)) lon = lon[0];
            if (Array.isArray(lat)) lat = lat[0];

            // Build the values object by stripping non-PID query params
            let values = _.omit(req.query, ['eml', 'v', 'session', 'id', 'time', 'kff1005', 'kff1006']);

            // Resolve user (positive + negative cache). Keep the 403 gate:
            // unknown emails are NEVER buffered or forwarded.
            let user = await resolveUser(eml);
            if (!user) return res.status(403).send('Invalid user account.');

            // Resolve session (find-or-create) — caches the resolved numeric FK.
            let currentSession = await Session.findOrCreate({
                where: { sessionId: session },
                defaults: { userId: user.id }
            });
            let sess = currentSession[0];

            // Buffer the row (resolved numeric FKs only) and let it flush async.
            ingestBuffer.ingest({
                userId: user.id,
                sessionId: sess.id,
                time: new Date(Number(time)),
                lon: lon != null ? Number(lon) : null,
                lat: lat != null ? Number(lat) : null,
                values: values,
                engineRpm: Number(values.k4) || null,
                vehicleSpeed: Number(values.k5) || null
            });

            // Respond immediately — do NOT await the DB flush.
            res.status(200).send('OK!');

            // Fire-and-forget forwardUrls (SSRF-guarded, native fetch, 3s timeout).
            // Deliberately outside the request path: never awaited.
            if (Array.isArray(user.forwardUrls) && user.forwardUrls.length) {
                setImmediate(async () => {
                    for (const url of user.forwardUrls) {
                        try {
                            if (await ssrfGuard.isSafeUrl(url)) {
                                await fetch(url, {
                                    method: 'GET',
                                    signal: AbortSignal.timeout(3000)
                                }).catch(() => {});
                            }
                            // unsafe URLs are skipped silently
                        } catch (e) {
                            // isSafeUrl rejected / unexpected error — skip this URL
                        }
                    }
                });
            }
        } catch (err) {
            res.sendStatus(500);
            console.log(err);
        }
    }
}

module.exports = UploadController;
