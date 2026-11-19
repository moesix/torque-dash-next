'use strict';

const sequelize = require('../models').sequelize;
const { collectStatus } = require('../services/status');
// requireAdmin writes the 403 JSON itself and returns false; the route keeps
// the real `authenticate` middleware, so anonymous requests never reach here.
const { requireAdmin } = require('./UserController');

class StatusController {
    static async get(req, res, next) {
        if (!requireAdmin(req, res)) return;
        try {
            const data = await collectStatus(sequelize);
            return res.json({ status: 'ok', ...data });
        } catch (err) {
            // collectStatus swallows per-block failures; anything reaching here
            // is unexpected and belongs in the shared JSON error middleware.
            return next(err);
        }
    }
}

module.exports = StatusController;
