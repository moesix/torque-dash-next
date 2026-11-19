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
    // Stubs the rest of the model module so routes/api.js can be required by
    // the route-order test below (the real routers pull every controller).
    Log: {
        findAll: async () => [],
        findOne: async () => null,
        count: async () => 0,
    },
    User: { findOne: async () => null, findAll: async () => [] },
    Analysis: {
        findAll: async () => [],
        findOne: async () => null,
        count: async () => 0,
    },
    Settings: { findOne: async () => null, findAll: async () => [] },
    sequelize: {
        transaction: async (fn) => {
            dbCalls.transactions += 1;
            return fn({ LOCK: { UPDATE: 'UPDATE' } });
        },
        query: async () => [],
        fn: () => ({}),
        col: () => ({}),
    },
    Sequelize: {
        Op: {
            and: Symbol('and'),
            gt: Symbol('gt'),
            gte: Symbol('gte'),
            lte: Symbol('lte'),
            or: Symbol('or'),
            in: Symbol('in'),
            ne: Symbol('ne'),
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
function install({ vehicle = null, vehicleList = [], sessionUpdateResult = [0], sessionRows = [] } = {}) {
    dbCalls.transactions = 0;
    const calls = {
        vehicleFindAll: [],
        vehicleFindOne: [],
        vehicleCreate: [],
        vehicleUpdate: [],
        sessionUpdate: [],
        sessionFindAll: [],
        logFindAll: [],
        destroys: [],
    };
    mockModels.Vehicle.findAll = async (opts) => { calls.vehicleFindAll.push(opts); return vehicleList; };
    mockModels.Vehicle.findOne = async (opts) => { calls.vehicleFindOne.push(opts); return vehicle; };
    mockModels.Vehicle.create = async (attrs) => { calls.vehicleCreate.push(attrs); return attrs; };
    mockModels.Vehicle.update = async (patch, opts) => { calls.vehicleUpdate.push({ patch, opts }); return [1]; };
    mockModels.Session.update = async (patch, opts) => { calls.sessionUpdate.push({ patch, opts }); return sessionUpdateResult; };
    mockModels.Session.findAll = async (opts) => { calls.sessionFindAll.push(opts); return sessionRows; };
    mockModels.Log.findAll = async (opts) => { calls.logFindAll.push(opts); return []; };
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

// ── Fleet overview (Plan 021) ───────────────────────────────────────

describe('VehicleController.overview (fleet aggregation)', () => {
    test('aggregates per-vehicle activity/maxima over one Session query', async () => {
        const vehicles = [
            makeVehicle(1, { name: 'Alpha' }),
            makeVehicle(2, { name: 'Beta' }),
            makeVehicle(3, { name: 'Gamma' }),
        ];
        const rows = [
            // Alpha: two normal rows plus one whose denormalized summary is NULL
            // (counted, but contributes no activity/maxima).
            { vehicleId: 1, lastTimestamp: new Date('2026-11-10T10:00:00Z'), maxRpm: 5000, maxSpeed: 100 },
            { vehicleId: 1, lastTimestamp: new Date('2026-11-12T10:00:00Z'), maxRpm: 6200, maxSpeed: 140 },
            { vehicleId: 1, lastTimestamp: null, maxRpm: null, maxSpeed: null },
            // Beta: one session, all maxima NULL.
            { vehicleId: 2, lastTimestamp: new Date('2026-11-15T10:00:00Z'), maxRpm: null, maxSpeed: null },
            // Unassigned session.
            { vehicleId: null, lastTimestamp: new Date('2026-11-14T10:00:00Z'), maxRpm: 3000, maxSpeed: 60 },
        ];
        const calls = install({ vehicleList: vehicles, sessionRows: rows });

        const req = makeStubReq();
        const { res, calls: out } = makeStubRes();
        await VehicleController.overview(req, res);

        // Owner scoping on both reads; exactly ONE session query.
        assert.deepStrictEqual(calls.vehicleFindAll[0].where, { userId: 1 });
        assert.strictEqual(calls.sessionFindAll.length, 1, 'one Session.findAll');
        assert.deepStrictEqual(calls.sessionFindAll[0].where.userId, 1);
        // Denormalized columns only — never Logs.
        assert.deepStrictEqual(calls.sessionFindAll[0].attributes, [
            'vehicleId',
            'firstTimestamp',
            'lastTimestamp',
            'maxRpm',
            'maxSpeed',
        ]);
        assert.strictEqual(calls.logFindAll.length, 0, 'overview must never scan Logs');

        assert.strictEqual(out.statusCode, null);
        const byId = new Map(out.body.map((r) => [r.vehicleId, r]));
        // Zero-session vehicle is present (never dropped).
        assert.deepStrictEqual(
            { ...byId.get(3), lastActivityAt: null },
            {
                vehicleId: 3, name: 'Gamma', make: 'Toyota', model: 'Corolla',
                engineCc: 1800, sessionCount: 0, lastActivityAt: null,
                maxRpm: null, maxSpeed: null,
            },
        );
        // NULL maxima are ignored, not replaced by a Logs scan.
        const alpha = byId.get(1);
        assert.strictEqual(alpha.sessionCount, 3, 'NULL-summary row is still counted');
        assert.strictEqual(alpha.maxRpm, 6200);
        assert.strictEqual(alpha.maxSpeed, 140);
        assert.strictEqual(alpha.lastActivityAt.toISOString(), '2026-11-12T10:00:00.000Z');
        // A vehicle whose only session has NULL summary columns keeps nulls.
        assert.strictEqual(byId.get(2).sessionCount, 1);
        assert.strictEqual(byId.get(2).maxRpm, null);
        assert.strictEqual(byId.get(2).maxSpeed, null);
        // Unassigned bucket appended because it has sessions.
        const unassigned = byId.get(null);
        assert.strictEqual(unassigned.name, 'Unassigned');
        assert.strictEqual(unassigned.sessionCount, 1);
        assert.strictEqual(unassigned.maxSpeed, 60);

        // Most recent activity first, zero-activity vehicles last.
        assert.deepStrictEqual(out.body.map((r) => r.vehicleId), [2, null, 1, 3]);
    });

    test('clamps days to 1..365 and filters Sessions by lastTimestamp', async () => {
        const calls = install({ vehicleList: [], sessionRows: [] });
        const lastSince = () => {
            const where = calls.sessionFindAll[calls.sessionFindAll.length - 1].where;
            assert.deepStrictEqual(where.userId, 1);
            return where.lastTimestamp[mockModels.Sequelize.Op.gte];
        };

        let req = makeStubReq({ query: { days: '30' } });
        let stub = makeStubRes();
        await VehicleController.overview(req, stub.res);
        let since = lastSince();
        const thirtyDays = 30 * 86400e3;
        assert.ok(Math.abs(Date.now() - thirtyDays - since.getTime()) < 5000, '30-day window');

        req = makeStubReq({ query: { days: '9999' } });
        stub = makeStubRes();
        await VehicleController.overview(req, stub.res);
        since = lastSince();
        const year = 365 * 86400e3;
        assert.ok(Math.abs(Date.now() - year - since.getTime()) < 5000, 'clamped to 365');

        req = makeStubReq({ query: { days: '-5' } });
        stub = makeStubRes();
        await VehicleController.overview(req, stub.res);
        since = lastSince();
        assert.ok(Math.abs(Date.now() - 86400e3 - since.getTime()) < 5000, 'clamped to 1');
    });

    test('omits the Unassigned row when no unassigned session exists', async () => {
        install({
            vehicleList: [makeVehicle(1, { name: 'Alpha' })],
            sessionRows: [{ vehicleId: 1, lastTimestamp: new Date(), maxRpm: 1, maxSpeed: 2 }],
        });
        const req = makeStubReq();
        const { res, calls: out } = makeStubRes();
        await VehicleController.overview(req, res);
        assert.deepStrictEqual(out.body.map((r) => r.vehicleId), [1]);
    });

    test('route is registered before /vehicles/:vehicleId and returns 200', async () => {
        // Source-order gate (STOP condition 3): the literal route must come
        // first or Express treats "overview" as an :vehicleId.
        const src = require('fs').readFileSync(
            require.resolve('../routes/api.js'),
            'utf8',
        );
        const overviewAt = src.indexOf("router.get('/vehicles/overview'");
        const paramAt = src.indexOf("router.get('/vehicles/:vehicleId'");
        assert.ok(overviewAt !== -1, 'overview route exists');
        assert.ok(paramAt !== -1, ':vehicleId route exists');
        assert.ok(overviewAt < paramAt, 'overview must be registered BEFORE :vehicleId');

        // Runtime proof: boot the real router and dispatch the request. Auth is
        // stubbed pass-through; models stay mocked (no DB).
        const authPath = require.resolve('../middleware/auth');
        const previousAuth = require.cache[authPath];
        require.cache[authPath] = {
            id: authPath,
            filename: authPath,
            loaded: true,
            exports: (req, res, next) => next(),
        };
        const calls = install({
            vehicleList: [makeVehicle(1, { name: 'Alpha' })],
            sessionRows: [],
        });
        const router = require('../routes/api');
        const req = {
            method: 'GET',
            url: '/vehicles/overview',
            originalUrl: '/vehicles/overview',
            path: '/vehicles/overview',
            headers: {},
            query: {},
            params: {},
            user: { id: 1 },
            isAuthenticated: () => true,
            ip: '127.0.0.1',
            get: () => undefined,
            app: { get: () => undefined },
        };
        const out = { statusCode: 200, body: null, headers: {} };
        const res = {
            status(code) { out.statusCode = code; return res; },
            json(obj) { out.body = obj; return res; },
            setHeader(k, v) { out.headers[k] = v; return res; },
            set() { return res; },
            end() { return res; },
        };
        let handled = false;
        router(req, res, () => { handled = false; });
        // The controller is async; let its microtasks settle before asserting.
        await new Promise((resolve) => setImmediate(resolve));

        if (previousAuth) require.cache[authPath] = previousAuth;
        else delete require.cache[authPath];

        assert.strictEqual(handled, false);
        assert.strictEqual(out.statusCode, 200);
        assert.ok(Array.isArray(out.body), 'overview returns an array');
        assert.strictEqual(out.body[0].vehicleId, 1);
        // The ordering bug would run getOne, which calls Vehicle.findOne.
        assert.strictEqual(calls.vehicleFindOne.length, 0, ':vehicleId handler must not run');
        assert.strictEqual(calls.vehicleFindAll.length, 1, 'overview handler did run');
    });
});
