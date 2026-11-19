const Session = require('../models').Session;
const Log = require('../models').Log;
const Vehicle = require('../models').Vehicle;
const sequelize = require('../models').sequelize;
const Op = require('../models').Sequelize.Op;
const { nanoid } = require('nanoid');
const { discoverPidKeys, invalidatePidKeys, PID_REGISTRY } = require('../lib/pidRegistry');
const ingestBuffer = require('../services/ingestBuffer');
const { evictSession } = require('../lib/hotCaches');
// Summary aggregate lives in one place (plans/017) — re-exported below for
// existing consumers/tests.
const {
    aggregateSummaries,
    decorateWithSummaries,
    recomputeSummary,
} = require('../services/sessionSummaries');
// CSV helpers used by exportCsv.
const { sanitizeFilename, csvEscape, buildCsvHeader } = require('../lib/csvExport');
const { convert, resolveUnitSystem } = require('../lib/units');
const config = require('../config/config');
const {
  renameSchema,
  notesSchema,
  cutSchema,
  filterSchema,
  copySchema,
  joinSchema,
  addLocationSchema,
  csvUnitsSchema,
  isInt4Id,
} = require('../lib/validators');

class SessionController {
    static async delete(req, res, next) {
        try{
            // quiesce pending ingest rows before mutating Logs so buffered
            // frames can't resurrect deleted ranges
            await drainIngest();
            let userId = req.user.id;
            let sessionId = req.params.sessionId
            // Read the device sessionId BEFORE the destroy — it is the cache key
            // for the upload hot path and is gone once the row is deleted.
            const row = await Session.findOne({
                where: { id: sessionId, userId },
                attributes: ['id', 'sessionId'],
            });
            if(!row) return res.status(404).json({ error: 'Session not found' });
            await Session.destroy({ where: { id: sessionId, userId: userId } });
            evictSession(row.sessionId, userId);
            // Logs for this session are gone too, so the discovered PID key-set
            // cached under the integer session id is stale. Delete is a Log
            // mutation (drainIngest above) and follows the same invalidate rule
            // as cut/filter/copy/join.
            invalidatePidKeys(row.id);
            res.sendStatus(200);
        } catch (err) {
            next(err);
        }
    }
    static async getOne(req, res, next) {
        try{
            // Get session for user (no eager Log load — summary is aggregated)
            let session = await Session.findOne({
                where: { 
                    userId: req.user.id ,
                    id: req.params.sessionId
                },
                include: [{
                    model: Vehicle,
                    as: 'Vehicle',
                    attributes: ['id', 'name', 'make', 'model', 'year'],
                    required: false,
                }]
            });
            if(!session) return res.status(404).json({ error: 'Session not found' });

            // Single aggregate query for start/end + max speed/RPM; reuse the
            // session row just loaded (all summary columns are selected).
            const summaries = await aggregateSummaries([session.id], [session]);
            const s = summaries.get(session.id) || {};
            const out = decorateWithSummaries(session, s);
            out.vehicleId = session.vehicleId || null;
            out.vehicleName = session.Vehicle?.name || null;
            res.json(out);
        } catch (err) {
            next(err);
        }
    }
    static async getAll(req, res, next) {
        try {
            // Clamp pagination to limit [1,200] (default 50) and offset >= 0.
            // limit=0 → 50 is deliberate: 0 parses falsy and falls back to the
            // default rather than being clamped up to 1 (pinned by tests).
            const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
            const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

            // Optional vehicle filter: absent/'' = all sessions, 'none' =
            // unassigned, otherwise it must be an int4 id. Gate BEFORE Number()
            // so junk can't reach Sequelize as a Postgres 22P02/22003 500.
            const rawVehicleId = req.query.vehicleId;
            if (rawVehicleId !== undefined && rawVehicleId !== '' && rawVehicleId !== 'none'
                && !isInt4Id(rawVehicleId)) {
                return res.status(400).json({ error: 'Invalid vehicleId.' });
            }
            const vehicleId = rawVehicleId ? Number(rawVehicleId) : null;

            // The route sits behind `authenticate`, whose passport
            // deserializeUser already loaded the user (and rejects a deleted
            // one), so the identity in req.user is authoritative — the old
            // existence `User.findOne` was a duplicate query per page.

            // Build where clause with optional vehicleId filter
            const where = { userId: req.user.id };
            if (vehicleId) where.vehicleId = vehicleId;
            else if (req.query.vehicleId === 'none') where.vehicleId = null;

            // Get paginated sessions for user (no eager Log load)
            let sessions = await Session.findAll({
                where,
                include: [{
                    model: Vehicle,
                    as: 'Vehicle',
                    attributes: ['id', 'name', 'make', 'model', 'year'],
                    required: false,
                }],
                limit,
                offset,
                order: [['createdAt', 'DESC']]
            });

            const total = await Session.count({ where });

            // Decorate from the rows just loaded: the page query already selected
            // every Sessions column, so the summary seam must not re-select them.
            // ONE grouped Log aggregate still runs for any NULL-summary rows.
            const summaries = await aggregateSummaries(sessions.map(s => s.id), sessions);
            const out = sessions.map(session => {
                const s = summaries.get(session.id) || {};
                const json = decorateWithSummaries(session, s);
                json.vehicleId = session.vehicleId || null;
                json.vehicleName = session.Vehicle?.name || null;
                return json;
            });
            // Personal, mutation-sensitive list: never serve from the HTTP cache.
            // The SPA's query cache handles snappiness; a stale 30s window made
            // renames and deletes look like they failed.
            res.set('Cache-Control', 'private, no-store');
            res.vary('Cookie');
            res.json({ sessions: out, total, limit, offset });
        } catch (err) {
            next(err);
        }
    }
    static async rename(req, res, next) {
        try {
            const { error: valErr } = renameSchema.validate(req.body);
            if (valErr) {
                return res.status(400).json({ error: valErr.details[0].message });
            }
            const [affectedCount] = await Session.update(
                { name: req.body.name },
                { where: { 
                    id: req.params.sessionId, 
                    userId: req.user.id 
                    } 
                }
            )
            if (affectedCount === 0) return res.status(404).json({ error: 'Session not found' });
            res.sendStatus(200);
        } catch (err) {
            next(err);
        }
    }
    static async updateNotes(req, res, next) {
        try {
            const { error: valErr } = notesSchema.validate(req.body);
            if (valErr) {
                return res.status(400).json({ error: valErr.details[0].message });
            }
            const { notes } = req.body;
            const session = await loadOwnedSession(req.params.sessionId, req.user.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            await session.update({ notes: notes || null });
            res.json({ ok: true, notes: session.notes });
        } catch (err) {
            next(err);
        }
    }
    static async addLocation(req, res, next) {
        try {
            let session = await loadOwnedSession(req.params.sessionId, req.user.id);
            if(!session) return res.status(404).json({ error: 'Session not found' });
            const { error: valErr } = addLocationSchema.validate(req.body);
            if (valErr) {
                return res.status(400).json({ error: valErr.details[0].message });
            }
            await Session.update(
                { startLocation: req.body.locations.start,
                  endLocation: req.body.locations.end },
                { where: { 
                    id: req.params.sessionId, 
                    userId: req.user.id 
                    } 
                }
            )
            res.sendStatus(200);
        } catch (err) {
            next(err);
        }
    }
    static async copy(req, res, next) {
        try {
            await drainIngest();
            const { error: valErr } = copySchema.validate(req.body);
            if (valErr) {
                return res.status(400).json({ error: valErr.details[0].message });
            }
            // Session lookup and null check BEFORE the transaction
            let session = await loadOwnedSession(req.params.sessionId, req.user.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            let sessionCopy;
            await sequelize.transaction( async (t) => {
                // Create a copy of the session
                sessionCopy = await Session.create({
                    sessionId: nanoid(),
                    name: req.body.name,
                    startLocation: session.startLocation,
                    endLocation: session.endLocation,
                    notes: session.notes ?? null,
                    vehicleId: session.vehicleId ?? null,
                    userId: session.userId
                }, { transaction: t });
                // Copy logs server-side via INSERT...SELECT (never load rows into Node.js)
                await sequelize.query(
                    `INSERT INTO "Logs" ("sessionId", timestamp, lon, lat, values, engine_rpm, vehicle_speed)
                     SELECT :newSessionId, timestamp, lon, lat, values, engine_rpm, vehicle_speed
                     FROM "Logs"
                     WHERE "sessionId" = :oldSessionId`,
                    {
                        replacements: { newSessionId: sessionCopy.id, oldSessionId: session.id },
                        transaction: t
                    }
                );
            });
            await recomputeSummary(sessionCopy.id);
            res.sendStatus(200);
        } catch (err) {
            next(err);
        }
    }
    static async filter(req, res, next) {
        try {
            await drainIngest();
            const { error: valErr } = filterSchema.validate(req.body);
            if (valErr) {
                return res.status(400).json({ error: valErr.details[0].message });
            }
            let filterNumber = parseInt(req.body.filterNumber, 10);
            let session = await loadOwnedSession(req.params.sessionId, req.user.id);
            if(!session) return res.status(404).json({ error: 'Session not found' });
            // Quick count check — if filterNumber exceeds total logs, nothing to do
            const logCount = await Log.count({ where: { sessionId: session.id } });
            if(filterNumber > logCount) return res.sendStatus(200);
            
            // Keep rows at 1-indexed positions N, 2N, 3N, … and delete everything else.
            // The subquery is the set to DELETE (rn % N != 0); `id IN` — not `id NOT IN` —
            // is what selects it. The previous `id NOT IN` deleted the multiples and kept
            // ~(N-1)/N of the rows (a 5x downsample kept 80%).
            await sequelize.query(`
                DELETE FROM "Logs"
                WHERE "sessionId" = :sessionId
                  AND id IN (
                      SELECT id FROM (
                          SELECT id, ROW_NUMBER() OVER (ORDER BY timestamp) as rn
                          FROM "Logs"
                          WHERE "sessionId" = :sessionId
                      ) sub
                      WHERE rn % :filterNumber != 0
                  )
            `, {
                replacements: { sessionId: session.id, filterNumber: filterNumber }
            });
            await recomputeSummary(session.id);
            res.sendStatus(200);
        } catch (err) {
            next(err);
        }
    }
    static async cut(req, res, next) {
        try {
            await drainIngest();
            const { error: valErr } = cutSchema.validate(req.body);
            if (valErr) {
                return res.status(400).json({ error: valErr.details[0].message });
            }
            let { from, to } = req.body

            let session = await loadOwnedSession(req.params.sessionId, req.user.id);
            if(!session) return res.status(404).json({ error: 'Session not found' });
            
            // delete logs
            await Log.destroy({ where: {
                sessionId: session.id,
                timestamp: {
                    [Op.and]: {
                        [Op.gte]: from,
                        [Op.lte]: to
                      }
                }
            }});
            await recomputeSummary(session.id);
            res.sendStatus(200);
        } catch (err) {
            next(err);
        }
    }
    static async join(req, res, next) {
        try {
            await drainIngest();
            const { error: valErr } = joinSchema.validate(req.body);
            if (valErr) {
                return res.status(400).json({ error: valErr.details[0].message });
            }
            let { joinSessionId, name } = req.body
            let sessionOne = await loadOwnedSession(req.params.sessionId, req.user.id);
            let sessionTwo = await loadOwnedSession(joinSessionId, req.user.id);
            if(!sessionOne || !sessionTwo) return res.status(404).json({ error: 'Session not found' }); 

            let joinSession;
            await sequelize.transaction( async (t) => {
                // create new session — a join inherits the PRIMARY (first) source
                // session's vehicle so the result stays visible under that
                // vehicle filter instead of falling into "Unassigned".
                joinSession = await Session.create({
                    sessionId: nanoid(),
                    name: name,
                    vehicleId: sessionOne.vehicleId ?? null,
                    userId: req.user.id
                }, { transaction: t });
                // Copy logs from both sessions server-side via INSERT...SELECT
                await Promise.all([
                    sequelize.query(
                        `INSERT INTO "Logs" ("sessionId", timestamp, lon, lat, values, engine_rpm, vehicle_speed)
                         SELECT :targetSessionId, timestamp, lon, lat, values, engine_rpm, vehicle_speed
                         FROM "Logs"
                         WHERE "sessionId" = :sourceSessionId
                         ON CONFLICT ("sessionId", timestamp) DO NOTHING`,
                        {
                            replacements: { targetSessionId: joinSession.id, sourceSessionId: sessionOne.id },
                            transaction: t
                        }
                    ),
                    sequelize.query(
                        `INSERT INTO "Logs" ("sessionId", timestamp, lon, lat, values, engine_rpm, vehicle_speed)
                         SELECT :targetSessionId, timestamp, lon, lat, values, engine_rpm, vehicle_speed
                         FROM "Logs"
                         WHERE "sessionId" = :sourceSessionId
                         ON CONFLICT ("sessionId", timestamp) DO NOTHING`,
                        {
                            replacements: { targetSessionId: joinSession.id, sourceSessionId: sessionTwo.id },
                            transaction: t
                        }
                    )
                ]);
            });
            await recomputeSummary(joinSession.id);
            res.sendStatus(200);
        } catch (err) {
            next(err);
        }
    }
    static async exportCsv(req, res) {
        try {
            // 1. Ownership check
            const session = await loadOwnedSession(req.params.sessionId, req.user.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            // 1a. HEAD short-circuit. The client fires HEAD /export/csv as a cheap
            // reachability/auth pre-check before the real download, and Express
            // dispatches HEAD to this GET handler. Without this, HEAD runs the full
            // export (PID discovery + paginated scan) with the body discarded. The
            // ownership check above already proved session existence + user match, so
            // answering 200 with no body still proves authorization for the client.
            if (req.method === 'HEAD') return res.end();

            // 1b. Unit system: explicit ?units= wins, otherwise the caller's
            // saved preference (resolved through DEFAULT_UNIT_SYSTEM). Values
            // are converted at write time; stored rows stay canonical.
            const { error: unitsError, value: unitsQuery } = csvUnitsSchema.validate(req.query || {});
            if (unitsError) {
                return res.status(400).json({ error: unitsError.details[0].message });
            }
            const unitSystem = unitsQuery.units
                || resolveUnitSystem(req.user.unitSystem, config.units.defaultSystem);

            // 2. Discover all k* PID keys via jsonb_object_keys SQL
            const pidKeys = await discoverPidKeys(session.id, sequelize);

            // 3. Set headers for streaming CSV download
            const filename = sanitizeFilename(session.name || `session-${session.id}`);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
            res.setHeader('X-Units-System', unitSystem);

            // 4. Write header row: fixed columns + promoted hot columns + discovered PID keys
            const header = buildCsvHeader(pidKeys, unitSystem);
            // Prepend UTF-8 BOM for Excel compatibility; escape header values defensively
            res.write('\ufeff' + header.map(csvEscape).join(',') + '\n');

            // 5. Stream data rows using cursor-based pagination (no offset drift).
            //    Uses Op.gte + id exclusion for tie-breaking on identical timestamps.
            const BATCH_SIZE = 1000;
            let cursor = null; // { timestamp, id }
            let hasMore = true;

            while (hasMore) {
                const where = { sessionId: session.id };
                if (cursor) {
                    where[Op.or] = [
                        { timestamp: { [Op.gt]: cursor.timestamp } },
                        { timestamp: cursor.timestamp, id: { [Op.gt]: cursor.id } }
                    ];
                }

                const batch = await Log.findAll({
                    where,
                    attributes: ['id', 'timestamp', 'lat', 'lon', 'engine_rpm', 'vehicle_speed', 'values'],
                    order: [['timestamp', 'ASC'], ['id', 'ASC']],
                    limit: BATCH_SIZE,
                    raw: true
                });

                if (batch.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const row of batch) {
                    const values = row.values || {};
                    const cells = [
                        csvEscape(new Date(row.timestamp).toISOString()),
                        csvEscape(row.lat),
                        csvEscape(row.lon),
                        csvEscape(row.engine_rpm),
                        csvEscape(convert(row.vehicle_speed, 'km/h', unitSystem)),
                        ...pidKeys.map(k => csvEscape(
                            convert(values[k], PID_REGISTRY[k]?.unit || '', unitSystem)
                        ))
                    ];
                    const ok = res.write(cells.join(',') + '\n');
                    if (!ok) {
                        await new Promise(resolve => res.once('drain', resolve));
                    }
                }

                cursor = { timestamp: batch[batch.length - 1].timestamp, id: batch[batch.length - 1].id };
                if (batch.length < BATCH_SIZE) hasMore = false;
            }

            res.end();
        } catch (err) {
            console.error('[SessionController.exportCsv]', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Export failed' });
            } else {
                res.end();
            }
        }
    }

    static async reassignVehicle(req, res, next) {
        try {
            const { vehicleId } = req.body;
            // vehicleId can be a number (assign) or null (unassign)
            if (vehicleId !== null && vehicleId !== undefined) {
                const v = Number(vehicleId);
                if (!Number.isInteger(v) || v < 1) {
                    return res.status(400).json({ error: 'vehicleId must be a positive integer or null.' });
                }
                // Verify vehicle belongs to this user
                const vehicle = await Vehicle.findOne({
                    where: { id: v, userId: req.user.id },
                });
                if (!vehicle) {
                    return res.status(404).json({ error: 'Vehicle not found.' });
                }
            }

            const session = await loadOwnedSession(req.params.sessionId, req.user.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            await session.update({ vehicleId: vehicleId || null });
            res.json({ ok: true, vehicleId: session.vehicleId });
        } catch (err) {
            next(err);
        }
    }
}

module.exports = SessionController;

// ── Shared helpers ──────────────────────────────────────────────────────────

// Quiesce pending ingest rows before a Log mutation. A buffered frame that
// flushed after a cut/filter/delete would resurrect the range it just removed;
// copy/join would snapshot a Logs table that is still receiving rows.
async function drainIngest() {
    await ingestBuffer.drain();
}

async function loadOwnedSession(sessionId, userId) {
    return Session.findOne({ where: { id: sessionId, userId } });
}
