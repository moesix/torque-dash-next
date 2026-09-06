'use strict';

// Plan 110: behavioral coverage for VehicleController CRUD ownership — every
// handler must scope reads/writes by req.user.id (controller-level harness,
// same pattern as test/sessionController.test.js). Asserts status codes AND
// the where/create args the production controller passes to the models.

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// ── Pre-populate require.cache for ../models ────────────────────────
const mockModels = {
    Vehicle: {
        findOne: async () => null,
        findAll: async () => [],
        create: async () => ({}),
        update: async () => [0],
        destroy: async () => 0,
    },
    Session: {
        update: async () => [0],
        findOne: async () => null,
        findAll: async () => [],
    },
};

const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
    id: modelsPath,
    filename: modelsPath,
    loaded: true,
    exports: mockModels,
};

// ── Now safe to require the controller ──────────────────────────────
const VehicleController = require('../controllers/VehicleController');

// ── Helpers ─────────────────────────────────────────────────────────

function makeStubReq(overrides = {}) {
    return {
        user: { id: 1 },
        params: { vehicleId: '5' },
        body: {},
        query: {},
        ...overrides,
    };
}

function makeStubRes() {
    const calls = { statusCode: null, body: null };
    const res = {
        status(code) { calls.statusCode = code; return res; },
        json(obj) { calls.body = obj; return res; },
        sendStatus(code) { calls.statusCode = code; return res; },
        send(data) { calls.body = data; return res; },
    };
    return { res, calls };
}

// Per-test model wiring + recorders.
function install({ vehicle = null, vehicleList = [], sessionUpdateResult = [0] } = {}) {
    const calls = { vehicleFindAll: [], vehicleFindOne: [], vehicleCreate: [], sessionUpdate: [], destroys: [] };
    mockModels.Vehicle.findAll = async (opts) => { calls.vehicleFindAll.push(opts); return vehicleList; };
    mockModels.Vehicle.findOne = async (opts) => { calls.vehicleFindOne.push(opts); return vehicle; };
    mockModels.Vehicle.create = async (attrs) => { calls.vehicleCreate.push(attrs); return attrs; };
    mockModels.Session.update = async (patch, opts) => { calls.sessionUpdate.push({ patch, opts }); return sessionUpdateResult; };
    if (vehicle && typeof vehicle.destroy !== 'function') {
        vehicle.destroy = async () => { calls.destroys.push(vehicle.id); return vehicle; };
    }
    return calls;
}

function makeVehicle(id = 5, extra = {}) {
    const v = { id, name: 'My Car', make: 'Toyota', model: 'Corolla', year: 2020, engineCc: 1800, userId: 1, ...extra };
    return v;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('VehicleController (with mocked models)', () => {
    test('getAll returns only the authenticated user\u2019s vehicles', async () => {
        const list = [makeVehicle(1), makeVehicle(2)];
        const calls = install({ vehicleList: list });

        const req = makeStubReq();
        const { res, calls: out } = makeStubRes();
        await VehicleController.getAll(req, res);

        assert.deepStrictEqual(calls.vehicleFindAll[0].where, { userId: 1 }, 'findAll must be scoped to req.user.id');
        assert.deepStrictEqual(calls.vehicleFindAll[0].order, [['isDefault', 'DESC'], ['name', 'ASC']]);
        assert.deepStrictEqual(out.body, list);
    });

    test('getOne returns the vehicle for an owned id', async () => {
        const vehicle = makeVehicle(5);
        const calls = install({ vehicle });

        const req = makeStubReq();
        const { res, calls: out } = makeStubRes();
        await VehicleController.getOne(req, res);

        assert.deepStrictEqual(calls.vehicleFindOne[0], { where: { id: '5', userId: 1 } }, 'getOne must scope by owner');
        assert.deepStrictEqual(out.body, vehicle);
    });

    test('getOne on a foreign vehicle returns 404', async () => {
        const calls = install({ vehicle: null });

        const req = makeStubReq({ params: { vehicleId: '99' } });
        const { res, calls: out } = makeStubRes();
        await VehicleController.getOne(req, res);

        assert.strictEqual(out.statusCode, 404);
        assert.deepStrictEqual(out.body, { error: 'Vehicle not found' });
        assert.deepStrictEqual(calls.vehicleFindOne[0], { where: { id: '99', userId: 1 } });
    });

    test('create persists the trimmed name and req.user.id ownership', async () => {
        const calls = install();

        const req = makeStubReq({ body: { name: '  Tow Rig  ', make: 'Ford', model: 'F-250', year: 2019, engineCc: 6800 } });
        const { res, calls: out } = makeStubRes();
        await VehicleController.create(req, res);

        assert.strictEqual(out.statusCode, 201);
        assert.deepStrictEqual(calls.vehicleCreate[0], {
            name: 'Tow Rig',
            make: 'Ford',
            model: 'F-250',
            year: 2019,
            engineCc: 6800,
            userId: 1,
        }, 'create must stamp the owner id from the session');
    });

    test('create with a blank/absent name returns 400 before any insert', async () => {
        const calls = install();
        for (const name of [undefined, '', '   ', 42]) {
            const req = makeStubReq({ body: { name } });
            const { res, calls: out } = makeStubRes();
            await VehicleController.create(req, res);
            assert.strictEqual(out.statusCode, 400, `name=${JSON.stringify(name)}`);
            assert.deepStrictEqual(out.body, { error: 'Vehicle name is required.' });
        }
        assert.strictEqual(calls.vehicleCreate.length, 0, 'no insert for invalid names');
    });

    test('update mutates and saves an owned vehicle', async () => {
        const saved = [];
        const vehicle = makeVehicle(5);
        vehicle.save = async () => { saved.push(true); return vehicle; };
        const calls = install({ vehicle });

        const req = makeStubReq({ body: { name: '  Renamed Car  ', make: null } });
        const { res, calls: out } = makeStubRes();
        await VehicleController.update(req, res);

        assert.deepStrictEqual(calls.vehicleFindOne[0], { where: { id: '5', userId: 1 } });
        assert.strictEqual(vehicle.name, 'Renamed Car', 'name must be trimmed on update');
        assert.strictEqual(vehicle.make, null, 'make must be cleared when null is sent');
        assert.strictEqual(saved.length, 1, 'vehicle.save must run');
        assert.deepStrictEqual(out.body, vehicle);
    });

    test('update on a foreign vehicle returns 404 and never saves', async () => {
        const calls = install({ vehicle: null });

        const req = makeStubReq({ params: { vehicleId: '99' }, body: { name: 'Hijack' } });
        const { res, calls: out } = makeStubRes();
        await VehicleController.update(req, res);

        assert.strictEqual(out.statusCode, 404);
        assert.deepStrictEqual(out.body, { error: 'Vehicle not found' });
        assert.deepStrictEqual(calls.vehicleFindOne[0], { where: { id: '99', userId: 1 } }, 'update must look the vehicle up by owner');
    });

    test('delete unassigns the owner\u2019s sessions then destroys the owned vehicle', async () => {
        const vehicle = makeVehicle(5);
        const calls = install({ vehicle });

        const req = makeStubReq();
        const { res, calls: out } = makeStubRes();
        await VehicleController.delete(req, res);

        assert.strictEqual(out.statusCode, 200);
        assert.deepStrictEqual(calls.vehicleFindOne[0], { where: { id: '5', userId: 1 } });
        // Session unassign must be scoped to the vehicle AND the owner so a
        // shared vehicle id can never touch another user's sessions.
        assert.deepStrictEqual(calls.sessionUpdate[0].patch, { vehicleId: null });
        assert.deepStrictEqual(calls.sessionUpdate[0].opts, { where: { vehicleId: 5, userId: 1 } });
        assert.deepStrictEqual(calls.destroys, [5], 'the owned vehicle row must be destroyed');
    });

    test('delete on a foreign vehicle returns 404 and never unassigns or destroys', async () => {
        const calls = install({ vehicle: null });

        const req = makeStubReq({ params: { vehicleId: '99' } });
        const { res, calls: out } = makeStubRes();
        await VehicleController.delete(req, res);

        assert.strictEqual(out.statusCode, 404);
        assert.deepStrictEqual(out.body, { error: 'Vehicle not found' });
        assert.strictEqual(calls.sessionUpdate.length, 0, 'no session unassign for a foreign vehicle');
        assert.strictEqual(calls.destroys.length, 0, 'no destroy for a foreign vehicle');
    });
});
