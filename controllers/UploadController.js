const crypto = require('crypto');
const User = require('../models').User;
const Session = require('../models').Session;
const Vehicle = require('../models').Vehicle;
const Settings = require('../models').Settings;
const userCache = require('../lib/userCache');
const ssrfGuard = require('../lib/ssrfGuard');
const ingestBuffer = require('../services/ingestBuffer');
const runtime = require('../config/runtime');

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
            // ── AUTHENTICATION ──────────────────────────────────────────────
            // When UPLOAD_API_TOKEN is configured, bearer token is REQUIRED.
            // This is a security gate — email alone is not sufficient auth.
            const configuredToken = runtime.getUploadApiToken();
            if (configuredToken) {
                const authHeader = req.headers.authorization || '';
                if (!authHeader.startsWith('Bearer ')) {
                    return res.status(401).json({
                        error: 'Authorization header required',
                        hint: 'Set Authorization: Bearer <your-token> in Torque Pro'
                    });
                }
                const token = authHeader.slice(7);
                const tokenBuf = Buffer.from(token, 'utf8');
                const expectedBuf = Buffer.from(configuredToken, 'utf8');
                if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
                    return res.status(401).json({ error: 'Invalid upload token' });
                }
            }
            // ── END AUTHENTICATION ─────────────────────────────────────────

            let { eml, v, session, id, time, kff1005, kff1006, ...values } = req.query;
            let lon = kff1005;
            let lat = kff1006;

            // Torque may send repeated query params as arrays
            if (Array.isArray(lon)) lon = lon[0];
            if (Array.isArray(lat)) lat = lat[0];

            // Resolve user (positive + negative cache). Keep the 403 gate:
            // unknown emails are NEVER buffered or forwarded.
            let user = await resolveUser(eml);
            if (!user) return res.status(403).send('Invalid user account.');

            // Resolve vehicle from Torque's `v` param (vehicle profile name).
            // Falls back to the user's default vehicle when `v` is missing or
            // doesn't match any known vehicle name.
            let vehicle = null;
            if (v) {
                vehicle = await Vehicle.findOne({
                    where: { userId: user.id, name: v },
                });
            }
            if (!vehicle) {
                vehicle = await Vehicle.findOne({
                    where: { userId: user.id, isDefault: true },
                });
            }

            // Resolve session (find-or-create) — caches the resolved numeric FK.
            let currentSession = await Session.findOrCreate({
                where: { sessionId: session },
                defaults: {
                    userId: user.id,
                    vehicleId: vehicle ? vehicle.id : null,
                }
            });
            let sess = currentSession[0];

            // After findOrCreate, if this is a new session, give it a default name
            if (currentSession[1] && time) {
                // Fetch the user's timezone offset (minutes from UTC, e.g. 480 for UTC+8)
                const settings = await Settings.getSingleton();
                const offsetMinutes = settings?.timezoneOffset ?? 0;
                const d = new Date(Number(time));
                const ts = new Date(d.getTime() + offsetMinutes * 60000);
                const pad = (n) => String(n).padStart(2, '0');
                const name = `Trip ${pad(ts.getDate())}${pad(ts.getMonth() + 1)}${ts.getFullYear()} ${ts.getHours() % 12 || 12}:${pad(ts.getMinutes())}${ts.getHours() >= 12 ? 'PM' : 'AM'}`;
                await sess.update({ name });
            }

            // Buffer the row (resolved numeric FKs only) and let it flush async.
            ingestBuffer.ingest({
                userId: user.id,
                sessionId: sess.id,
                time: new Date(Number(time)),
                lon: lon != null ? Number(lon) : null,
                lat: lat != null ? Number(lat) : null,
                values: values,
                engineRpm: values.kc != null ? Number(values.kc) : null,
                vehicleSpeed: values.kd != null ? Number(values.kd) : null
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
            res.status(500).json({ error: 'Internal server error' });
            console.error(err.message || err);
        }
    }
}

module.exports = UploadController;
