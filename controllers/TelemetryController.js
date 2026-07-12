const Session = require('../models').Session;
const User = require('../models').User;
const Log = require('../models').Log;
const Op = require('../models').Sequelize.Op;

class TelemetryController {
    // GET /api/sessions/:id/telemetry?from&to&limit[&shareId]
    // Enforces ownership (or shared access via ?shareId) and returns paged frames.
    static async range(req, res) {
        try {
            const { from, to, limit, shareId } = req.query;
            if (!from || !to) {
                return res.status(400).json({ error: 'from and to are required' });
            }

            let session;
            if (shareId) {
                const user = await User.findOne({ where: { shareId } });
                if (!user) return res.status(404).json({ error: 'Not found' });
                session = await Session.findOne({ where: { userId: user.id, id: req.params.id } });
            } else {
                if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
                session = await Session.findOne({ where: { userId: req.user.id, id: req.params.id } });
            }
            if (!session) return res.status(404).json({ error: 'Not found' });

            const rows = await Log.findAll({
                where: {
                    sessionId: session.id,
                    timestamp: { [Op.between]: [new Date(from), new Date(to)] }
                },
                // NOTE: model attributes are engine_rpm / vehicle_speed (matching the
                // DB columns added by infra/timescale/log_hypertable.sql); the plan's
                // engineRpm/vehicleSpeed casing would select non-existent columns.
                attributes: ['timestamp', 'lon', 'lat', 'values', 'engine_rpm', 'vehicle_speed'],
                order: [['timestamp', 'ASC']],
                limit: Math.min(Number(limit) || 5000, 10000)
            });
            res.json(rows);
        } catch (err) {
            console.error('[TelemetryController.range]', err);
            res.sendStatus(500);
        }
    }
}

module.exports = TelemetryController;
