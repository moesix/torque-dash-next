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
            console.log(err);
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
            console.log(err);
            res.sendStatus(500);
        }
    }
    static async getAll(req, res) {
        try {
            // Check if user exists
            let user = await User.findOne({
                where: { id: req.user.id }
            });
            if(!user) return res.status(401);

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
            console.log(err);
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
            console.log(err);
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
            console.log(err);
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
            console.log(err);
            res.sendStatus(500);
        }
    }
    static async addLocation(req, res) {
        try {
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
            console.log(err);
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
            console.log(err);
            res.sendStatus(500);
        }
    }
    static async filter(req, res) {
        try {
            let filterNumber = parseInt(req.body.filterNumber);
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
            console.log(err);
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
            console.log(err);
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
            console.log(err);
            res.sendStatus(500);
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

module.exports = SessionController;