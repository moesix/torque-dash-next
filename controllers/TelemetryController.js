const Session = require('../models').Session;
const User = require('../models').User;
const Log = require('../models').Log;
const Op = require('../models').Sequelize.Op;
const { telemetryRangeSchema } = require('../lib/validators');

class TelemetryController {
    // GET /api/sessions/:id/telemetry?from&to&limit[&shareId]
    // Enforces ownership (or shared access via ?shareId) and returns paged frames.
    static async range(req, res) {
        try {
            const { from, to } = req.query;
            if (!from || !to) {
                return res.status(400).json({ error: 'from and to are required' });
            }

            // Wire the shared contract — telemetryRangeSchema (lib/validators,
            // previously dead code) requires from/to as ISO dates and validates
            // the limit/offset shape. Malformed ranges now 400 instead of
            // reaching Postgres as 500s. Two deliberate notes:
            //  * The schema's limit rule REJECTS out-of-range values, but this
            //    endpoint's contract CLAMPS oversized ones (999999 -> 10000,
            //    pinned by telemetryAccess tests); pre-clamp so Joi sees an
            //    in-range integer and the schema default (5000) still applies.
            //  * shareId is not a schema key, so unknown keys are allowed.
            const query = { ...req.query };
            const limitNum = Number(query.limit);
            if (query.limit !== undefined && Number.isFinite(limitNum) && limitNum > 10000) {
                query.limit = 10000;
            }
            const { error, value } = telemetryRangeSchema.validate(query, { allowUnknown: true });
            if (error) {
                return res.status(400).json({ error: error.message });
            }
            const { shareId, limit } = value;

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
                // Belt-and-braces clamp on the schema-coerced value: schema
                // default is already 5000 and oversized inputs were pre-clamped,
                // so this preserves the endpoint's historical default/clamp no
                // matter how the schema drifts.
                limit: Math.min(Number(limit) || 5000, 10000)
            });
            res.json(rows);
        } catch (err) {
            console.error('[TelemetryController.range]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
}

module.exports = TelemetryController;
