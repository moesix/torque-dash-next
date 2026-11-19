const Vehicle = require('../models').Vehicle;
const Session = require('../models').Session;
const sequelize = require('../models').sequelize;
const Op = require('../models').Sequelize.Op;
const { vehicleCreateSchema, vehicleUpdateSchema } = require('../lib/validators');

class VehicleController {
    /** List all vehicles for the authenticated user. */
    static async getAll(req, res, next) {
        try {
            const vehicles = await Vehicle.findAll({
                where: { userId: req.user.id },
                order: [['isDefault', 'DESC'], ['name', 'ASC']],
            });
            res.json(vehicles);
        } catch (err) {
            next(err);
        }
    }

    /** Get a single vehicle by ID. */
    static async getOne(req, res, next) {
        try {
            const vehicle = await Vehicle.findOne({
                where: { id: req.params.vehicleId, userId: req.user.id },
            });
            if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
            res.json(vehicle);
        } catch (err) {
            next(err);
        }
    }

    /**
     * Fleet overview: per-vehicle activity/counts/maxima over a selectable
     * window (Plan 021, DIR-06).
     *
     * Deliberately ONE `Session.findAll` over the denormalized summary columns
     * (`firstTimestamp`/`lastTimestamp`/`maxRpm`/`maxSpeed`, migration 016) —
     * never a `Logs` scan. Rows whose summary columns are still NULL (an
     * ingest that never ran the summary pass) are counted but contribute no
     * activity/maxima; there is intentionally no fallback scan.
     *
     * Every owned vehicle appears, including zero-session ones. Sessions with
     * `vehicleId: null` are returned as an extra "Unassigned" row when present.
     */
    static async overview(req, res, next) {
        try {
            // Same clamp rule as the rest of the API: absent/invalid → 90.
            const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
            const since = new Date(Date.now() - days * 86400e3);

            const vehicles = await Vehicle.findAll({
                where: { userId: req.user.id },
                order: [['isDefault', 'DESC'], ['name', 'ASC']],
            });

            const rows = await Session.findAll({
                where: {
                    userId: req.user.id,
                    lastTimestamp: { [Op.gte]: since },
                },
                attributes: [
                    'vehicleId',
                    'firstTimestamp',
                    'lastTimestamp',
                    'maxRpm',
                    'maxSpeed',
                ],
            });

            // Group in JS. `null` vehicleId collects the unassigned bucket.
            const groups = new Map();
            for (const row of rows) {
                const key = row.vehicleId == null ? null : Number(row.vehicleId);
                let g = groups.get(key);
                if (!g) {
                    g = { sessionCount: 0, lastActivityAt: null, maxRpm: null, maxSpeed: null };
                    groups.set(key, g);
                }
                g.sessionCount += 1;

                const last = row.lastTimestamp ? new Date(row.lastTimestamp) : null;
                if (last && (!g.lastActivityAt || last > g.lastActivityAt)) {
                    g.lastActivityAt = last;
                }
                // NULL maxima are ignored; a numeric string (driver nuance) is
                // coerced. Never trust the raw value enough to compare blindly.
                const rpm = row.maxRpm == null ? null : Number(row.maxRpm);
                if (rpm != null && Number.isFinite(rpm) && (g.maxRpm == null || rpm > g.maxRpm)) {
                    g.maxRpm = rpm;
                }
                const speed = row.maxSpeed == null ? null : Number(row.maxSpeed);
                if (speed != null && Number.isFinite(speed) && (g.maxSpeed == null || speed > g.maxSpeed)) {
                    g.maxSpeed = speed;
                }
            }

            const out = vehicles.map((v) => {
                const g = groups.get(v.id) || {
                    sessionCount: 0,
                    lastActivityAt: null,
                    maxRpm: null,
                    maxSpeed: null,
                };
                return {
                    vehicleId: v.id,
                    name: v.name,
                    make: v.make,
                    model: v.model,
                    engineCc: v.engineCc,
                    sessionCount: g.sessionCount,
                    lastActivityAt: g.lastActivityAt,
                    maxRpm: g.maxRpm,
                    maxSpeed: g.maxSpeed,
                };
            });

            const unassigned = groups.get(null);
            if (unassigned && unassigned.sessionCount > 0) {
                out.push({
                    vehicleId: null,
                    name: 'Unassigned',
                    make: null,
                    model: null,
                    engineCc: null,
                    sessionCount: unassigned.sessionCount,
                    lastActivityAt: unassigned.lastActivityAt,
                    maxRpm: unassigned.maxRpm,
                    maxSpeed: unassigned.maxSpeed,
                });
            }

            // Most recent activity first; zero-activity vehicles last.
            out.sort((a, b) => {
                const at = a.lastActivityAt ? a.lastActivityAt.getTime() : -Infinity;
                const bt = b.lastActivityAt ? b.lastActivityAt.getTime() : -Infinity;
                if (at !== bt) return bt - at;
                return String(a.name).localeCompare(String(b.name));
            });

            res.json(out);
        } catch (err) {
            next(err);
        }
    }

    /** Create a new vehicle. */
    static async create(req, res, next) {
        try {
            const { error } = vehicleCreateSchema.validate(req.body);
            if (error) return res.status(400).json({ error: error.details[0].message });

            const { name, make, model, year, engineCc } = req.body;
            if (!name || typeof name !== 'string' || name.trim().length === 0) {
                return res.status(400).json({ error: 'Vehicle name is required.' });
            }
            const vehicle = await Vehicle.create({
                name: name.trim(),
                make: make || null,
                model: model || null,
                year: year || null,
                engineCc: engineCc || null,
                userId: req.user.id,
            });
            res.status(201).json(vehicle);
        } catch (err) {
            next(err);
        }
    }

    /** Update a vehicle. */
    static async update(req, res, next) {
        try {
            const { error } = vehicleUpdateSchema.validate(req.body);
            if (error) return res.status(400).json({ error: error.details[0].message });

            const vehicle = await Vehicle.findOne({
                where: { id: req.params.vehicleId, userId: req.user.id },
            });
            if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

            const { name, make, model, year, engineCc } = req.body;
            if (name !== undefined) {
                if (typeof name !== 'string' || name.trim().length === 0) {
                    return res.status(400).json({ error: 'Vehicle name cannot be empty.' });
                }
                vehicle.name = name.trim();
            }
            if (make !== undefined) vehicle.make = make;
            if (model !== undefined) vehicle.model = model;
            if (year !== undefined) vehicle.year = year;
            if (engineCc !== undefined) vehicle.engineCc = engineCc;
            await vehicle.save();
            res.json(vehicle);
        } catch (err) {
            next(err);
        }
    }

    /** Delete a vehicle. Sessions are unassigned (SET NULL on FK). */
    static async delete(req, res, next) {
        try {
            const vehicle = await Vehicle.findOne({
                where: { id: req.params.vehicleId, userId: req.user.id },
            });
            if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

            // Unassign sessions before deleting
            await Session.update(
                { vehicleId: null },
                { where: { vehicleId: vehicle.id, userId: req.user.id } }
            );
            await vehicle.destroy();
            res.sendStatus(200);
        } catch (err) {
            next(err);
        }
    }

    /** Set a vehicle as default. Unsets all others for this user. */
    static async setDefault(req, res, next) {
        try {
            // One transaction so the unset and the set cannot interleave with
            // another request (two defaults used to be possible). The row lock
            // serializes concurrent calls for the same vehicle; the partial
            // unique index (migration 027) is the backstop.
            const result = await sequelize.transaction(async (t) => {
                const vehicle = await Vehicle.findOne({
                    where: { id: req.params.vehicleId, userId: req.user.id },
                    transaction: t,
                    lock: t.LOCK.UPDATE,
                });
                if (!vehicle) return null;

                // Unset all defaults for this user
                await Vehicle.update(
                    { isDefault: false },
                    { where: { userId: req.user.id }, transaction: t }
                );
                // Set this one as default
                await vehicle.update({ isDefault: true }, { transaction: t });
                return vehicle;
            });
            if (!result) return res.status(404).json({ error: 'Vehicle not found' });
            res.json(result);
        } catch (err) {
            next(err);
        }
    }
}

module.exports = VehicleController;
