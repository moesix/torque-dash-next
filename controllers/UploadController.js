const crypto = require('crypto');
const User = require('../models').User;
const Session = require('../models').Session;
const Vehicle = require('../models').Vehicle;
const Settings = require('../models').Settings;
const userCache = require('../lib/userCache');
const ingestBuffer = require('../services/ingestBuffer');
const runtime = require('../config/runtime');

// Dedicated hot-path caches for the per-frame identity lookups. When the
// loaded userCache module doesn't expose the class (slim test doubles inject
// a plain get/set/del object), fall back to using that object as the backend.
const UserCacheClass = userCache.UserCache || null;
const vehicleCache = UserCacheClass ? new UserCacheClass({ ttl: 300_000, max: 1000 }) : userCache;
const sessionCache = UserCacheClass ? new UserCacheClass({ ttl: 60_000, max: 5000 }) : userCache;

// Express turns repeated query params (`kc=100&kc=200`) into arrays. Scalar
// fields that are coerced or stored as single values take the first element,
// matching the device's intent (a repeated param is a retry artefact).
const scalar = (v) => (Array.isArray(v) ? v[0] : v);

// Resolve an email to a User, using the positive + negative TTL cache.
// Returns the user, or null if unknown (unknown emails are cached as negatives).
async function resolveUser(eml) {
    if (!eml) return null;
    eml = eml.toLowerCase(); // normalize identity boundary (unifies cache keys too)
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
            eml = scalar(eml);

            // Validate `session` BEFORE any DB access — a missing/garbage value
            // must never reach Sequelize (it would throw → 500 → device retry storm).
            if (!session || typeof session !== 'string' || session.length > 255) {
                return res.status(400).json({
                    error: 'session parameter is required and must be a string (max 255 chars).'
                });
            }

            // `time` contract: PRESENT but unparseable → 400. ABSENT → server-now
            // fallback. Rejecting absent `time` would 400 older/edge clients and
            // trigger a device retry storm; an Invalid Date row, by contrast,
            // would poison the whole ingest buffer, so that is rejected here.
            const rawTs = time == null || time === '' ? Date.now() : Number(scalar(time));
            const tsDate = new Date(rawTs);
            if (!Number.isFinite(rawTs) || !Number.isFinite(tsDate.getTime())) {
                return res.status(400).json({ error: 'Invalid time parameter.' });
            }

            let lon = scalar(kff1005);
            let lat = scalar(kff1006);

            // Resolve user (positive + negative cache). Keep the 403 gate:
            // unknown emails are NEVER buffered or forwarded.
            let user = await resolveUser(eml);
            if (!user) return res.status(403).json({ error: 'Invalid user account.' });

            // Resolve vehicle from Torque's `v` param (vehicle profile name).
            // Falls back to the user's default vehicle when `v` is missing or
            // doesn't match any known vehicle name. Both lookups are TTL-cached
            // (5 min) with negative caching — rename/default staleness is
            // bounded by the TTL and accepted for single-operator scale.
            let vehicle = null;
            if (v) {
                const vKey = `vn:${user.id}:${v}`;
                vehicle = vehicleCache.get(vKey);
                if (vehicle === undefined) {
                    vehicle = await Vehicle.findOne({
                        where: { userId: user.id, name: v },
                    });
                    vehicleCache.set(vKey, vehicle || null); // negative-cache a miss
                }
            }
            if (!vehicle) {
                const dKey = `vd:${user.id}`;
                vehicle = vehicleCache.get(dKey);
                if (vehicle === undefined) {
                    vehicle = await Vehicle.findOne({
                        where: { userId: user.id, isDefault: true },
                    });
                    vehicleCache.set(dKey, vehicle || null);
                }
            }

            // Resolve session (find-or-create) — caches the resolved numeric FK.
            // POSITIVE-ONLY cache (never store "not found": findOrCreate creates
            // on demand), keyed per user per device string, short TTL.
            const sKey = `s:${user.id}:${session}`;
            let sess = sessionCache.get(sKey);
            let wasCreated = false;
            if (!sess) {
                const [createdSession, createdFlag] = await Session.findOrCreate({
                    where: { sessionId: session, userId: user.id },
                    defaults: {
                        userId: user.id,
                        vehicleId: vehicle ? vehicle.id : null,
                    }
                });
                sess = createdSession;
                wasCreated = createdFlag;
                sessionCache.set(sKey, sess);
            }

            // After findOrCreate, if this is a new session, give it a default name
            if (wasCreated && time) {
                // Fetch the user's timezone offset (minutes from UTC, e.g. 480 for UTC+8)
                const settings = await Settings.getSingleton();
                const offsetMinutes = settings?.timezoneOffset ?? 0;
                const d = tsDate;
                const ts = new Date(d.getTime() + offsetMinutes * 60000);
                const pad = (n) => String(n).padStart(2, '0');
                // UTC getters on the shifted timestamp: the shift makes UTC
                // components equal the target wall clock, so naming is
                // host-timezone-independent.
                const name = `Trip ${pad(ts.getUTCDate())}${pad(ts.getUTCMonth() + 1)}${ts.getUTCFullYear()} ${ts.getUTCHours() % 12 || 12}:${pad(ts.getUTCMinutes())}${ts.getUTCHours() >= 12 ? 'PM' : 'AM'}`;
                await sess.update({ name });
            }

            // Buffer the row (resolved numeric FKs only) and let it flush async.
            // Only the promoted numeric columns are scalarized; the rest of the
            // JSONB `values` bag keeps its raw shape (unknown PIDs may hold
            // string payloads).
            const kc = scalar(values.kc);
            const kd = scalar(values.kd);
            ingestBuffer.ingest({
                userId: user.id,
                sessionId: sess.id,
                time: tsDate,
                lon: lon != null ? Number(lon) : null,
                lat: lat != null ? Number(lat) : null,
                values: values,
                engineRpm: kc != null ? Number(kc) : null,
                vehicleSpeed: kd != null ? Number(kd) : null
            });

            // Respond immediately — do NOT await the DB flush.
            res.status(200).send('OK!');
        } catch (err) {
            res.status(500).json({ error: 'Internal server error' });
            console.error(err.message || err);
        }
    }
}

module.exports = UploadController;
// Exported for direct unit testing of the module-private resolver.
module.exports.resolveUser = resolveUser;

// Drop the cached device-session → numeric FK mapping for one session. Called
// after a session row is deleted so the next upload re-resolves (and recreates)
// it instead of buffering frames against a nonexistent FK.
function evictSession(sessionKey, userId) {
    if (sessionKey == null || userId == null) return;
    sessionCache.del(`s:${userId}:${sessionKey}`);
}
module.exports.evictSession = evictSession;
