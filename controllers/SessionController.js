const Session = require('../models').Session;
const Log = require('../models').Log;
const User = require('../models').User;
const Vehicle = require('../models').Vehicle;
const sequelize = require('../models').sequelize;
const Op = require('../models').Sequelize.Op;
const { nanoid } = require('nanoid');
const { discoverPidKeys } = require('../lib/pidRegistry');
const {
  renameSchema,
  notesSchema,
  cutSchema,
  filterSchema,
  copySchema,
  joinSchema,
  addLocationSchema,
} = require('../lib/validators');

class SessionController {
    static async delete(req, res) {
        try{
            let userId = req.user.id;
            let sessionId = req.params.sessionId
            let session = await Session.destroy({ where: {id: sessionId, userId: userId } });
            if(!session) return res.status(404).json({ error: 'Session not found' });
            res.sendStatus(200);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async getOne(req, res) {
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

            // Single aggregate query for start/end + max speed/RPM.
            const summaries = await aggregateSummaries([session.id]);
            const s = summaries.get(session.id) || {};
            const out = decorateWithSummaries(session, s);
            out.vehicleId = session.vehicleId || null;
            out.vehicleName = session.Vehicle?.name || null;
            res.json(out);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async getAll(req, res) {
        try {
            const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
            const offset = parseInt(req.query.offset, 10) || 0;
            const vehicleId = req.query.vehicleId ? Number(req.query.vehicleId) : null;

            // Check if user exists
            let user = await User.findOne({
                where: { id: req.user.id }
            });
            if(!user) return res.status(401).json({ error: 'User not found' });

            // Build where clause with optional vehicleId filter
            const where = { userId: user.id };
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

            // ONE grouped aggregate query across fetched session ids — never per-session.
            const summaries = await aggregateSummaries(sessions.map(s => s.id));
            const out = sessions.map(session => {
                const s = summaries.get(session.id) || {};
                const json = decorateWithSummaries(session, s);
                json.vehicleId = session.vehicleId || null;
                json.vehicleName = session.Vehicle?.name || null;
                return json;
            });
            res.set('Cache-Control', 'private, max-age=30');
            res.json({ sessions: out, total, limit, offset });
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async getOneShared(req, res) {
        try{
            // Check if user exists
            let user = await User.findOne({
                where: { shareId: req.params.shareId }
            });
            if(!user) return res.status(404).json({ error: 'User not found' });

            // Get session for user (no eager Log load)
            let session = await Session.findOne({
                where: { 
                    userId: user.id,
                    id: req.params.sessionId
                }
            });
            if(!session) return res.status(404).json({ error: 'Session not found' });

            // Single aggregate query for start/end + max speed/RPM.
            const summaries = await aggregateSummaries([session.id]);
            const s = summaries.get(session.id) || {};
            const out = decorateWithSummaries(session, s);
            res.json(out);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async getAllShared(req, res) {
        try {
            // Check if user exists
            let user = await User.findOne({
                where: { shareId: req.params.shareId }
            });
            if(!user) return res.status(404).json({ error: 'User not found' });

            // Get all sessions for user (no eager Log load)
            let sessions = await Session.findAll({
                where: { userId: user.id }
            });

            // ONE grouped aggregate query across every session id — never per-session.
            const summaries = await aggregateSummaries(sessions.map(s => s.id));
            const out = sessions.map(session => {
                const s = summaries.get(session.id) || {};
                return decorateWithSummaries(session, s);
            });
            res.json(out);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async rename(req, res) {
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
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async updateNotes(req, res) {
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
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async addLocation(req, res) {
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
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async copy(req, res) {
        try {
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
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async filter(req, res) {
        try {
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
            
            // Delete every log except every Nth row using a SQL window function.
            // This keeps rows at positions filterNumber, 2*filterNumber, ... (1-indexed)
            // and deletes the rest — same semantics as the original JS loop but
            // executed entirely inside PostgreSQL without loading rows into Node.
            await sequelize.query(`
                DELETE FROM "Logs"
                WHERE "sessionId" = :sessionId
                  AND id NOT IN (
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
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async cut(req, res) {
        try {
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
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async join(req, res) {
        try {
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
                // create new session
                joinSession = await Session.create({
                    sessionId: nanoid(),
                    name: name,
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
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
    static async exportCsv(req, res) {
        try {
            // 1. Ownership check
            const session = await loadOwnedSession(req.params.sessionId, req.user.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            // 2. Discover all k* PID keys via jsonb_object_keys SQL
            const pidKeys = await discoverPidKeys(session.id, sequelize);

            // 3. Set headers for streaming CSV download
            const filename = sanitizeFilename(session.name || `session-${session.id}`);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);

            // 4. Write header row: fixed columns + promoted hot columns + discovered PID keys
            const fixedCols = ['timestamp', 'lat', 'lon', 'engine_rpm', 'vehicle_speed'];
            const header = [...fixedCols, ...pidKeys];
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
                        csvEscape(row.vehicle_speed),
                        ...pidKeys.map(k => csvEscape(values[k]))
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

    static async reassignVehicle(req, res) {
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
            console.error('[SessionController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
}

// Aggregated session summary (start/end time + max speed/RPM) computed with a
// single GROUP BY query — replaces the legacy per-session summary that issued
// two Log.findAll() queries per session and loaded every log row. Uses the real
// Log columns (vehicle_speed, engine_rpm) confirmed against models/Log.js.
async function aggregateSummaries(sessionIds) {
    const map = new Map();
    if (!sessionIds || sessionIds.length === 0) return map;

    // Read denormalized columns from Session first
    const sessions = await Session.findAll({
        where: { id: sessionIds },
        attributes: ['id', 'firstTimestamp', 'lastTimestamp', 'maxRpm', 'maxSpeed'],
        raw: true,
    });

    const missingIds = [];
    for (const s of sessions) {
        if (s.firstTimestamp != null) {
            map.set(s.id, {
                start: s.firstTimestamp,
                end: s.lastTimestamp,
                maxSpeed: s.maxSpeed,
                maxRpm: s.maxRpm,
            });
        } else {
            missingIds.push(s.id);
        }
    }

    // Fallback to Log aggregate for sessions with NULL denormalized columns
    if (missingIds.length > 0) {
        const rows = await Log.findAll({
            where: { sessionId: missingIds },
            attributes: [
                'sessionId',
                [sequelize.fn('min', sequelize.col('timestamp')), 'start'],
                [sequelize.fn('max', sequelize.col('timestamp')), 'end'],
                [sequelize.fn('max', sequelize.col('vehicle_speed')), 'maxSpeed'],
                [sequelize.fn('max', sequelize.col('engine_rpm')), 'maxRpm']
            ],
            group: ['sessionId']
        });

        for (const row of rows) {
            const d = row.dataValues;
            map.set(d.sessionId, {
                start: d.start || null,
                end: d.end || null,
                maxSpeed: (d.maxSpeed != null) ? d.maxSpeed : null,
                maxRpm: (d.maxRpm != null) ? d.maxRpm : null
            });
        }
    }
    return map;
}

// Format a [start, end] pair into a compact human-readable duration string.
// Returns null when either bound is missing.
// Produces e.g. "1h 2m 5s" or "3d 1h 0m 5s", trimming leading zero units.
function formatDuration(start, end) {
    if (!start || !end) return null;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 0) return null;
    const totalSeconds = Math.floor(ms / 1000);
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

// Strip path-dangerous chars from session names for Content-Disposition filenames,
// replace spaces with hyphens, and cap at 100 characters.
function sanitizeFilename(name) {
    return (String(name)
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 100)
    ) || 'session';
}

// Escape a single CSV cell value: null/undefined -> empty string; if the value
// contains commas, double-quotes, newlines, carriage returns, or tabs, wrap it
// in double-quotes and escape embedded quotes as "".  Also prefix cells starting
// with +, -, =, @, or | with a single quote to prevent Excel formula injection.
function csvEscape(val) {
    if (val === null || val === undefined) return '';
    let str = String(val);
    // Excel formula injection guard: prefix dangerous leading chars
    if (/^[+\-=@|]/.test(str)) {
        str = "'" + str;
    }
    if (/[,"\n\r\t]/.test(str)) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

module.exports = SessionController;
module.exports.formatDuration = formatDuration;
module.exports.sanitizeFilename = sanitizeFilename;
module.exports.csvEscape = csvEscape;
module.exports.loadOwnedSession = loadOwnedSession;
module.exports.decorateWithSummaries = decorateWithSummaries;
module.exports.aggregateSummaries = aggregateSummaries;
module.exports.recomputeSummary = recomputeSummary;
module.exports.safeSharedSession = safeSharedSession;

// ── Shared helpers ──────────────────────────────────────────────────────────

async function loadOwnedSession(sessionId, userId) {
    return Session.findOne({ where: { id: sessionId, userId } });
}

function decorateWithSummaries(session, summary) {
    const out = session.toJSON ? session.toJSON() : session;
    out.startDate = summary.start || null;
    out.endDate = summary.end || null;
    out.duration = formatDuration(summary.start, summary.end);
    out.maxSpeed = summary.maxSpeed ?? null;
    out.maxRpm = summary.maxRpm ?? null;
    return out;
}

async function recomputeSummary(sessionId) {
    if (!sessionId) return;
    const log = await Log.findOne({
        where: { sessionId },
        attributes: [
            [sequelize.fn('min', sequelize.col('timestamp')), 'start'],
            [sequelize.fn('max', sequelize.col('timestamp')), 'end'],
            [sequelize.fn('max', sequelize.col('vehicle_speed')), 'maxSpeed'],
            [sequelize.fn('max', sequelize.col('engine_rpm')), 'maxRpm'],
        ],
        raw: true,
    });
    if (!log) return;
    await Session.update(
        {
            firstTimestamp: log.start || null,
            lastTimestamp: log.end || null,
            maxRpm: log.maxRpm || null,
            maxSpeed: log.maxSpeed || null,
        },
        { where: { id: sessionId } }
    );
}

function safeSharedSession(session, summary) {
    const EXCLUDE = new Set(['notes', 'sessionId', 'vehicleId', 'vehicleName', 'userId', 'updatedAt']);
    const out = {};
    for (const [key, value] of Object.entries(session)) {
        if (!EXCLUDE.has(key)) out[key] = value;
    }
    out.startDate = summary.start || null;
    out.endDate = summary.end || null;
    out.duration = formatDuration(summary.start, summary.end);
    out.maxSpeed = summary.maxSpeed ?? null;
    out.maxRpm = summary.maxRpm ?? null;
    return out;
}