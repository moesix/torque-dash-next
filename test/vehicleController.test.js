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
// `transaction` is instrumented so the setDefault tests can prove both writes
// run inside one transaction (plan 033).
const dbCalls = { transactions: 0 };
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
    sequelize: {
        transaction: async (fn) => {
            dbCalls.transactions += 1;
            return fn({ LOCK: { UPDATE: 'UPDATE' } });
        },
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
    dbCalls.transactions = 0;
    const calls = { vehicleFindAll: [], vehicleFindOne: [], vehicleCreate: [], vehicleUpdate: [], sessionUpdate: [], destroys: [] };
    mockModels.Vehicle.findAll = async (opts) => { calls.vehicleFindAll.push(opts); return vehicleList; };
    mockModels.Vehicle.findOne = async (opts) => { calls.vehicleFindOne.push(opts); return vehicle; };
    mockModels.Vehicle.create = async (attrs) => { calls.vehicleCreate.push(attrs); return attrs; };
    mockModels.Vehicle.update = async (patch, opts) => { calls.vehicleUpdate.push({ patch, opts }); return [1]; };
    mockModels.Session.update = async (patch, opts) => { calls.sessionUpdate.push({ patch, opts }); return sessionUpdateResult; };
    if (vehicle && typeof vehicle.destroy !== 'function') {
        vehicle.destroy = async () => { calls.destroys.push(vehicle.id); return vehicle; };
    }
    if (vehicle && typeof vehicle.update !== 'function') {
        vehicle.update = async (patch, opts) => {
            calls.vehicleUpdate.push({ patch, opts, instance: vehicle.id });
            Object.assign(vehicle, patch);
            return vehicle;
        };
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
        // Joi-handled shapes (missing/empty/non-string): the schema writes the
        // message, so only assert the JSON error contract.
        for (const name of [undefined, '', 42]) {
            const req = makeStubReq({ body: { name } });
            const { res, calls: out } = makeStubRes();
            await VehicleController.create(req, res);
            assert.strictEqual(out.statusCode, 400, `name=${JSON.stringify(name)}`);
            assert.strictEqual(typeof out.body.error, 'string', `name=${JSON.stringify(name)}`);
        }

        // Whitespace-only passes Joi (min(1), no trim) and hits the
        // controller's explicit guard — assert its exact message.
        const req = makeStubReq({ body: { name: '   ' } });
        const { res, calls: out } = makeStubRes();
        await VehicleController.create(req, res);
        assert.strictEqual(out.statusCode, 400);
        assert.deepStrictEqual(out.body, { error: 'Vehicle name is required.' });

        assert.strictEqual(calls.vehicleCreate.length, 0, 'no insert for invalid names');
    });

    test('create persists an SPA blank-vehicle payload (nulls) as 201', async () => {
        const calls = install();

        const req = makeStubReq({
            body: { name: 'Tow Rig', make: null, model: null, year: null, engineCc: null },
        });
        const { res, calls: out } = makeStubRes();
        await VehicleController.create(req, res);

        assert.strictEqual(out.statusCode, 201, JSON.stringify(out.body));
        assert.deepStrictEqual(calls.vehicleCreate[0], {
            name: 'Tow Rig',
            make: null,
            model: null,
            year: null,
            engineCc: null,
            userId: 1,
        }, 'blank optional fields must persist as NULL, not 400');
    });

    test('create with an invalid year returns 400 before any insert', async () => {
        const calls = install();
        const req = makeStubReq({ body: { name: 'Car', year: 'abc' } });
        const { res, calls: out } = makeStubRes();
        await VehicleController.create(req, res);
        assert.strictEqual(out.statusCode, 400);
        assert.strictEqual(typeof out.body.error, 'string');
        assert.strictEqual(calls.vehicleCreate.length, 0, 'no insert for an invalid year');
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

    test('setDefault runs both writes in one transaction and locks the target row', async () => {
        const vehicle = makeVehicle(5);
        const calls = install({ vehicle });

        const req = makeStubReq();
        const { res, calls: out } = makeStubRes();
        await VehicleController.setDefault(req, res);

        assert.strictEqual(dbCalls.transactions, 1, 'setDefault must open exactly one transaction');
        assert.strictEqual(out.statusCode, null, 'a successful call must not set an error status');
        assert.deepStrictEqual(out.body, vehicle);

        const find = calls.vehicleFindOne[0];
        assert.deepStrictEqual(find.where, { id: '5', userId: 1 });
        assert.ok(find.transaction, 'findOne must join the transaction');
        assert.strictEqual(find.lock, 'UPDATE', 'findOne must take the row lock');

        // 1) clear every default for this user (in the tx)
        assert.deepStrictEqual(calls.vehicleUpdate[0].patch, { isDefault: false });
        assert.deepStrictEqual(calls.vehicleUpdate[0].opts.where, { userId: 1 });
        assert.ok(calls.vehicleUpdate[0].opts.transaction, 'the bulk unset must join the transaction');
        // 2) set only the target default (in the tx)
        assert.strictEqual(calls.vehicleUpdate[1].instance, 5);
        assert.deepStrictEqual(calls.vehicleUpdate[1].patch, { isDefault: true });
        assert.ok(calls.vehicleUpdate[1].opts.transaction, 'the instance update must join the transaction');
        assert.strictEqual(calls.vehicleUpdate.length, 2, 'no third write');
    });

    test('setDefault on a foreign vehicle returns 404 and writes nothing', async () => {
        const calls = install({ vehicle: null });

        const req = makeStubReq({ params: { vehicleId: '99' } });
        const { res, calls: out } = makeStubRes();
        await VehicleController.setDefault(req, res);

        assert.strictEqual(out.statusCode, 404);
        assert.deepStrictEqual(out.body, { error: 'Vehicle not found' });
        assert.strictEqual(calls.vehicleUpdate.length, 0, 'no unset for a foreign vehicle');
        assert.strictEqual(dbCalls.transactions, 1, 'the lookup still ran in a transaction');
    });
});
