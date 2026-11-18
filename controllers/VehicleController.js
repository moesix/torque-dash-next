const Vehicle = require('../models').Vehicle;
const Session = require('../models').Session;
const sequelize = require('../models').sequelize;
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
