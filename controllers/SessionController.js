const Session = require('../models').Session;
const Log = require('../models').Log;
const User = require('../models').User;
const sequelize = require('../models').sequelize;
const Op = require('../models').Sequelize.Op;
const moment = require('moment');
require('moment-duration-format');
const shortid = require('shortid');

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
                // find the session
                let session = await Session.findOne({
                    where: { 
                        userId: req.user.id,
                        id: req.params.sessionId
                        },
                        include: {all:true}
                });
                // Create a copy of the session
                let sessionCopy = await Session.create({
                    sessionId: shortid.generate(),
                    name: req.body.name,
                    startLocation: session.startLocation,
                    endLocation: session.endLocation,
                    userId: session.userId
                });
                // Create copy for each session log
                await Promise.all(session.Logs.map(async log => {
                    try{
                        await Log.create({
                            sessionId: sessionCopy.id,
                            timestamp: log.dataValues.timestamp,
                            lon: log.dataValues.lon,
                            lat: log.dataValues.lat,
                            values: log.dataValues.values
                        });
                    }
                    catch (err) {
                        console.log(err);
                        res.sendStatus(500);
                    }
                  }));
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
            // get session logs
            let logs = await session.getLogs({raw:true});
            if(filterNumber > logs.length) return res.sendStatus(200);
            
            // get list of log ids to be filtered
            let logsToBeFiltered = [];
            for (let i = filterNumber - 1; i < logs.length; i += filterNumber) {
                logsToBeFiltered.push(logs[i].id);
            }
            // delete logs
            await Log.destroy({ where: {
                sessionId: session.id,
                id: { [Op.notIn]: logsToBeFiltered}
            }});
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
                },
                include: {all:true}
            });
            let sessionTwo = await Session.findOne({
                where: { 
                    id: joinSessionId, 
                    userId: req.user.id
                },
                include: {all:true}
            })
            if(!sessionOne || !sessionTwo) return res.sendStatus(404); 

            await sequelize.transaction( async (t) => {
                // create new session
                let joinSession = await Session.create({
                    sessionId: shortid.generate(),
                    name: name,
                    userId: req.user.id
                });
                // Create new joined logs
                await Promise.all(sessionOne.Logs.map(async log => {
                    try{
                        await Log.create({
                            sessionId: joinSession.id,
                            timestamp: log.dataValues.timestamp,
                            lon: log.dataValues.lon,
                            lat: log.dataValues.lat,
                            values: log.dataValues.values
                        });
                    }
                    catch (err) {
                        console.log(err);
                        res.sendStatus(500);
                    }
                }));
                await Promise.all(sessionTwo.Logs.map(async log => {
                    try{
                        await Log.create({
                            sessionId: joinSession.id,
                            timestamp: log.dataValues.timestamp,
                            lon: log.dataValues.lon,
                            lat: log.dataValues.lat,
                            values: log.dataValues.values
                        });
                    }
                    catch (err) {
                        console.log(err);
                        res.sendStatus(500);
                    }
                }));
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