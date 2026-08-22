const Vehicle = require('../models').Vehicle;
const Session = require('../models').Session;

class VehicleController {
    /** List all vehicles for the authenticated user. */
    static async getAll(req, res) {
        try {
            const vehicles = await Vehicle.findAll({
                where: { userId: req.user.id },
                order: [['isDefault', 'DESC'], ['name', 'ASC']],
            });
            res.json(vehicles);
        } catch (err) {
            console.error('[VehicleController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    /** Get a single vehicle by ID. */
    static async getOne(req, res) {
        try {
            const vehicle = await Vehicle.findOne({
                where: { id: req.params.vehicleId, userId: req.user.id },
            });
            if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
            res.json(vehicle);
        } catch (err) {
            console.error('[VehicleController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    /** Create a new vehicle. */
    static async create(req, res) {
        try {
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
            console.error('[VehicleController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    /** Update a vehicle. */
    static async update(req, res) {
        try {
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
            console.error('[VehicleController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    /** Delete a vehicle. Sessions are unassigned (SET NULL on FK). */
    static async delete(req, res) {
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
            console.error('[VehicleController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    /** Set a vehicle as default. Unsets all others for this user. */
    static async setDefault(req, res) {
        try {
            const vehicle = await Vehicle.findOne({
                where: { id: req.params.vehicleId, userId: req.user.id },
            });
            if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

            // Unset all defaults for this user
            await Vehicle.update(
                { isDefault: false },
                { where: { userId: req.user.id } }
            );
            // Set this one as default
            vehicle.isDefault = true;
            await vehicle.save();
            res.json(vehicle);
        } catch (err) {
            console.error('[VehicleController]', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
}

module.exports = VehicleController;
