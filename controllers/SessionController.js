const Session = require('../models').Session;
const Log = require('../models').Log;
const User = require('../models').User;
const sequelize = require('../models').sequelize;
const Op = require('../models').Sequelize.Op;
const moment = require('moment');
require('moment-duration-format');
const { nanoid } = require('nanoid');

class SessionController {
    static async delete(req, res) {
        try{
            let userId = req.user.id;
            let sessionId = req.params.sessionId
            let session = await Session.destroy({ where: {id: sessionId, userId: userId } });
            if(!session) return res.status(401).send('Session not found');
            res.sendStatus(200);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.sendStatus(500);
        }
    }
    static async getOne(req, res) {
        try{
            // Get session for user (no eager Log load — summary is aggregated)
            let session = await Session.findOne({
                where: { 
                    userId: req.user.id ,
                    id: req.params.sessionId
                }
            });
            if(!session) return res.status(404).send('Resource not found');

            // Single aggregate query for start/end + max speed/RPM.
            const summaries = await aggregateSummaries([session.id]);
            const s = summaries.get(session.id) || {};
            const out = session.toJSON();
            out.startDate = s.start || null;
            out.endDate = s.end || null;
            out.duration = formatDuration(s.start, s.end);
            out.maxSpeed = (s.maxSpeed != null) ? s.maxSpeed : null;
            out.maxRpm = (s.maxRpm != null) ? s.maxRpm : null;
            res.json(out);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.sendStatus(500);
        }
    }
    static async getAll(req, res) {
        try {
            // Check if user exists
            let user = await User.findOne({
                where: { id: req.user.id }
            });
            if(!user) return res.status(401).json({ error: 'User not found' });

            // Get all sessions for user (no eager Log load)
            let sessions = await Session.findAll({
                where: { userId: user.id }
            });

            // ONE grouped aggregate query across every session id — never per-session.
            const summaries = await aggregateSummaries(sessions.map(s => s.id));
            const out = sessions.map(session => {
                const s = summaries.get(session.id) || {};
                const json = session.toJSON();
                json.startDate = s.start || null;
                json.endDate = s.end || null;
                json.duration = formatDuration(s.start, s.end);
                json.maxSpeed = (s.maxSpeed != null) ? s.maxSpeed : null;
                json.maxRpm = (s.maxRpm != null) ? s.maxRpm : null;
                return json;
            });
            res.json(out);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.sendStatus(500);
        }
    }
    static async getOneShared(req, res) {
        try{
            // Check if user exists
            let user = await User.findOne({
                where: { shareId: req.params.shareId }
            });
            if(!user) return res.sendStatus(404);

            // Get session for user (no eager Log load)
            let session = await Session.findOne({
                where: { 
                    userId: user.id,
                    id: req.params.sessionId
                }
            });
            if(!session) return res.sendStatus(404);

            // Single aggregate query for start/end + max speed/RPM.
            const summaries = await aggregateSummaries([session.id]);
            const s = summaries.get(session.id) || {};
            const out = session.toJSON();
            out.startDate = s.start || null;
            out.endDate = s.end || null;
            out.duration = formatDuration(s.start, s.end);
            out.maxSpeed = (s.maxSpeed != null) ? s.maxSpeed : null;
            out.maxRpm = (s.maxRpm != null) ? s.maxRpm : null;
            res.json(out);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.sendStatus(500);
        }
    }
    static async getAllShared(req, res) {
        try {
            // Check if user exists
            let user = await User.findOne({
                where: { shareId: req.params.shareId }
            });
            if(!user) return res.sendStatus(404);

            // Get all sessions for user (no eager Log load)
            let sessions = await Session.findAll({
                where: { userId: user.id }
            });

            // ONE grouped aggregate query across every session id — never per-session.
            const summaries = await aggregateSummaries(sessions.map(s => s.id));
            const out = sessions.map(session => {
                const s = summaries.get(session.id) || {};
                const json = session.toJSON();
                json.startDate = s.start || null;
                json.endDate = s.end || null;
                json.duration = formatDuration(s.start, s.end);
                json.maxSpeed = (s.maxSpeed != null) ? s.maxSpeed : null;
                json.maxRpm = (s.maxRpm != null) ? s.maxRpm : null;
                return json;
            });
            res.json(out);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.sendStatus(500);
        }
    }
    static async rename(req, res) {
        try {
            await Session.update(
                { name: req.body.name },
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
            res.sendStatus(500);
        }
    }
    static async addLocation(req, res) {
        try {
            let session = await Session.findOne({
                where: {
                    id: req.params.sessionId,
                    userId: req.user.id
                }
            });
            if(!session) return res.sendStatus(404);
            // ── VALIDATION ──────────────────────────────────────────────
            if (!req.body.locations || !req.body.locations.start || !req.body.locations.end) {
                return res.status(400).json({
                    error: 'locations.start and locations.end are required'
                });
            }
            // ── END VALIDATION ──────────────────────────────────────────
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
            res.sendStatus(500);
        }
    }
    static async copy(req, res) {
        try {
            await sequelize.transaction( async (t) => {
                // find the session (without loading logs into memory)
                let session = await Session.findOne({
                    where: { 
                        userId: req.user.id,
                        id: req.params.sessionId
                        }
                });
                // Create a copy of the session
                let sessionCopy = await Session.create({
                    sessionId: nanoid(),
                    name: req.body.name,
                    startLocation: session.startLocation,
                    endLocation: session.endLocation,
                    userId: session.userId
                });
                // Fetch log data as raw objects (not Sequelize models) to avoid
                // hydrating thousands of model instances into memory.
                const logs = await Log.findAll({
                    where: { sessionId: session.id },
                    raw: true
                });
                // Bulk copy all logs with resolved FK in a single INSERT
                if (logs.length > 0) {
                    const copyRows = logs.map(l => ({
                        sessionId: sessionCopy.id,
                        timestamp: l.timestamp,
                        lon: l.lon,
                        lat: l.lat,
                        values: l.values,
                        engine_rpm: l.engine_rpm,
                        vehicle_speed: l.vehicle_speed
                    }));
                    await Log.bulkCreate(copyRows, { ignoreDuplicates: true });
                }
            });
            res.sendStatus(200);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.sendStatus(500);
        }
    }
    static async filter(req, res) {
        try {
            let filterNumber = parseInt(req.body.filterNumber, 10);
            // Validate filterNumber prevents data destruction (modulo by zero or one)
            if (isNaN(filterNumber) || filterNumber < 2) {
                return res.status(400).json({
                    error: 'filterNumber must be an integer >= 2'
                });
            }
            let session = await Session.findOne({ 
                where: { 
                    id: req.params.sessionId, 
                    userId: req.user.id 
                }
            });
            if(!session) return res.sendStatus(404);
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
            res.sendStatus(200);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.sendStatus(500);
        }
    }
    static async cut(req, res) {
        try {
            let { from, to } = req.body
            let session = await Session.findOne({ 
                where: { 
                    id: req.params.sessionId, 
                    userId: req.user.id 
                }
            });
            if(!session) return res.sendStatus(404);
            
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
            res.sendStatus(200);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.sendStatus(500);
        }
    }
    static async join(req, res) {
        try {
            let { joinSessionId, name } = req.body
            let sessionOne = await Session.findOne({ 
                where: { 
                    id: req.params.sessionId, 
                    userId: req.user.id
                }
            });
            let sessionTwo = await Session.findOne({
                where: { 
                    id: joinSessionId, 
                    userId: req.user.id
                }
            })
            if(!sessionOne || !sessionTwo) return res.sendStatus(404); 

            await sequelize.transaction( async (t) => {
                // create new session
                let joinSession = await Session.create({
                    sessionId: nanoid(),
                    name: name,
                    userId: req.user.id
                });
                // Fetch logs from both sessions as raw objects (not Sequelize models)
                const [logsOne, logsTwo] = await Promise.all([
                    Log.findAll({ where: { sessionId: sessionOne.id }, raw: true }),
                    Log.findAll({ where: { sessionId: sessionTwo.id }, raw: true })
                ]);
                // Bulk copy all logs from both sessions in a single INSERT
                const copyRows = [
                    ...logsOne.map(l => ({
                        sessionId: joinSession.id,
                        timestamp: l.timestamp,
                        lon: l.lon,
                        lat: l.lat,
                        values: l.values,
                        engine_rpm: l.engine_rpm,
                        vehicle_speed: l.vehicle_speed
                    })),
                    ...logsTwo.map(l => ({
                        sessionId: joinSession.id,
                        timestamp: l.timestamp,
                        lon: l.lon,
                        lat: l.lat,
                        values: l.values,
                        engine_rpm: l.engine_rpm,
                        vehicle_speed: l.vehicle_speed
                    }))
                ];
                if (copyRows.length > 0) {
                    await Log.bulkCreate(copyRows, { ignoreDuplicates: true });
                }
            });
            res.sendStatus(200);
        }
        catch (err) {
            console.error('[SessionController]', err);
            res.sendStatus(500);
        }
    }
    static async exportCsv(req, res) {
        try {
            // 1. Ownership check
            const session = await Session.findOne({
                where: { id: req.params.sessionId, userId: req.user.id }
            });
            if (!session) return res.status(404).json({ error: 'Session not found' });

            // 2. Discover all k* PID keys via jsonb_object_keys SQL
            const [keyRows] = await sequelize.query(`
                SELECT DISTINCT key FROM (
                    SELECT jsonb_object_keys(values) AS key
                    FROM "Logs" WHERE "sessionId" = :sessionId
                ) sub
                WHERE key ~ '^k' AND length(key) > 1
                ORDER BY key
            `, { replacements: { sessionId: session.id } });

            const pidKeys = keyRows.map(r => r.key);

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
                    res.write(cells.join(',') + '\n');
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
}

// Aggregated session summary (start/end time + max speed/RPM) computed with a
// single GROUP BY query — replaces the legacy per-session summary that issued
// two Log.findAll() queries per session and loaded every log row. Uses the real
// Log columns (vehicle_speed, engine_rpm) confirmed against models/Log.js.
async function aggregateSummaries(sessionIds) {
    const map = new Map();
    if (!sessionIds || sessionIds.length === 0) return map;

    const rows = await Log.findAll({
        where: { sessionId: sessionIds },
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
    return map;
}

// Format a [start, end] pair into a compact human-readable duration string.
// Returns null when either bound is missing. moment-duration-format (imported at
// top) lets us trim leading/trailing zero units, e.g. "1h 02m 05s".
function formatDuration(start, end) {
    if (!start || !end) return null;
    const ms = new Date(end) - new Date(start);
    if (isNaN(ms) || ms < 0) return null;
    return moment.duration(ms).format('d[d] h[h] m[m] s[s]', { trim: 'both' });
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