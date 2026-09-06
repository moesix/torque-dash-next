'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw
// (same pattern as test/sessionController.test.js).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Grab the REAL userCache module BEFORE we inject mocks into require.cache,
// so the del() suite below still exercises production code.
const realUserCache = require('../lib/userCache');

// ── Pre-populate require.cache for everything UploadController pulls in ──
// UploadController requires ../models (which builds a real Sequelize instance),
// ../lib/userCache, ../lib/ssrfGuard, ../services/ingestBuffer and
// ../config/runtime at load time. We inject stub containers for all five so
// the tests below run against PRODUCTION controller code with no DB.

const mockModels = {
    User: { findOne: async () => null },
    Session: { findOrCreate: async () => [{ id: 7 }, false] },
    Vehicle: { findOne: async () => null },
    Settings: { getSingleton: async () => ({ timezoneOffset: 0 }) },
};

const mockUserCache = {
    store: new Map(),
    get(key) { return mockUserCache.store.get(key); },
    set(key, value) { mockUserCache.store.set(key, value); },
    del(key) { mockUserCache.store.delete(key); },
};

const mockSsrfGuard = { safeFetch: async () => ({}) };

const ingestCalls = [];
const mockIngestBuffer = {
    ingest(row) { ingestCalls.push(row); },
};

const mockRuntime = {
    token: null,
    getUploadApiToken() { return mockRuntime.token; },
    isFromEnv() { return false; },
    setUploadApiToken(v) { mockRuntime.token = v; },
};

function inject(resolvedPath, exportsObj) {
    require.cache[resolvedPath] = {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        exports: exportsObj,
    };
}

inject(require.resolve('../models'), mockModels);
inject(require.resolve('../lib/userCache'), mockUserCache);
inject(require.resolve('../lib/ssrfGuard'), mockSsrfGuard);
inject(require.resolve('../services/ingestBuffer'), mockIngestBuffer);
inject(require.resolve('../config/runtime'), mockRuntime);

// ── Now safe to require the production controller ──────────────────
const UploadController = require('../controllers/UploadController');

// ── Helpers ─────────────────────────────────────────────────────────

function makeReq(query) {
    return { headers: {}, query };
}

function makeRes() {
    const calls = { statusCode: null, body: null };
    const res = {
        status(code) { calls.statusCode = code; return res; },
        json(obj) { calls.body = obj; return res; },
        send(data) { calls.body = data; return res; },
    };
    return { res, calls };
}

// Recorded calls for assertions (re-created by stubHappyPath).
let findOneCalls;
let findOrCreateArgs;
let sessionUpdateCalls;

// Wire default per-test behavior: auth disabled, known user, existing session.
function stubHappyPath({ user = { id: 1, forwardUrls: [] }, createsSession = false, timezoneOffset = 0 } = {}) {
    findOneCalls = [];
    findOrCreateArgs = null;
    sessionUpdateCalls = [];

    mockModels.User.findOne = async (args) => {
        findOneCalls.push(args);
        return user;
    };
    mockModels.Vehicle.findOne = async () => ({ id: 3 });
    mockModels.Session.findOrCreate = async (args) => {
        findOrCreateArgs = args;
        const sess = {
            id: 7,
            update: async (patch) => { sessionUpdateCalls.push(patch); },
        };
        return [sess, createsSession];
    };
    mockModels.Settings.getSingleton = async () => ({ timezoneOffset });

    mockUserCache.store.clear();
    ingestCalls.length = 0;
    mockRuntime.token = null; // bearer-token gate OFF
}

// ── Session parameter validation — through the REAL processUpload ──────

describe('Upload hardening – session validation via processUpload', () => {
    const ERROR_MSG = 'session parameter is required and must be a string (max 255 chars).';

    test('missing session returns 400 JSON before any DB access', async () => {
        stubHappyPath();
        const { res, calls } = makeRes();
        await UploadController.processUpload(makeReq({ eml: 'user@x.com' }), res);
        assert.strictEqual(calls.statusCode, 400);
        assert.deepStrictEqual(calls.body, { error: ERROR_MSG });
        assert.strictEqual(findOneCalls.length, 0, 'resolveUser must not hit the DB');
    });

    test('empty-string session returns 400', async () => {
        stubHappyPath();
        const { res, calls } = makeRes();
        await UploadController.processUpload(makeReq({ eml: 'user@x.com', session: '' }), res);
        assert.strictEqual(calls.statusCode, 400);
        assert.deepStrictEqual(calls.body, { error: ERROR_MSG });
        assert.strictEqual(findOneCalls.length, 0);
    });

    test('non-string (array) session returns 400', async () => {
        stubHappyPath();
        const { res, calls } = makeRes();
        // Torque repeated params arrive as arrays in req.query
        await UploadController.processUpload(makeReq({ eml: 'user@x.com', session: ['abc'] }), res);
        assert.strictEqual(calls.statusCode, 400);
        assert.strictEqual(findOneCalls.length, 0);
    });

    test('numeric session returns 400', async () => {
        stubHappyPath();
        const { res, calls } = makeRes();
        await UploadController.processUpload(makeReq({ eml: 'user@x.com', session: 12345 }), res);
        assert.strictEqual(calls.statusCode, 400);
        assert.strictEqual(findOneCalls.length, 0);
    });

    test('session longer than 255 chars returns 400', async () => {
        stubHappyPath();
        const { res, calls } = makeRes();
        await UploadController.processUpload(makeReq({ eml: 'user@x.com', session: 'a'.repeat(256) }), res);
        assert.strictEqual(calls.statusCode, 400);
        assert.strictEqual(findOneCalls.length, 0);
    });

    test('session at exactly 255 chars passes and reaches resolveUser', async () => {
        stubHappyPath();
        const { res, calls } = makeRes();
        await UploadController.processUpload(makeReq({
            eml: 'user@x.com',
            session: 'a'.repeat(255),
            v: 'Car',
            time: String(Date.parse('2026-08-25T14:30:00Z')),
        }), res);
        assert.strictEqual(calls.statusCode, 200);
        assert.strictEqual(calls.body, 'OK!');
        assert.strictEqual(findOneCalls.length, 1, 'valid session flows into resolveUser');
        assert.deepStrictEqual(findOneCalls[0], { where: { email: 'user@x.com' } });
    });

    test('valid session passes and reaches resolveUser', async () => {
        stubHappyPath();
        const { res, calls } = makeRes();
        await UploadController.processUpload(makeReq({
            eml: 'user@x.com',
            session: 'abc-123',
            v: 'Car',
        }), res);
        assert.strictEqual(calls.statusCode, 200);
        assert.strictEqual(findOneCalls.length, 1, 'resolveUser was reached');
    });
});

// ── findOrCreate scoping — through the REAL processUpload ──────────────

describe('Upload hardening – findOrCreate scoped by userId', () => {
    test('where-clause contains both sessionId and userId', async () => {
        stubHappyPath();
        const { res } = makeRes();
        await UploadController.processUpload(makeReq({
            eml: 'user@x.com',
            session: 'abc-123',
        }), res);
        assert.ok(findOrCreateArgs, 'Session.findOrCreate was called');
        assert.deepStrictEqual(findOrCreateArgs.where, { sessionId: 'abc-123', userId: 1 });
        assert.deepStrictEqual(findOrCreateArgs.defaults, { userId: 1, vehicleId: 3 });
    });
});

// ── UTC trip naming — through the REAL processUpload ───────────────────
// A new session + `time` triggers the naming path; we capture sess.update().

describe('Upload hardening – UTC trip naming via processUpload', () => {
    function nameFor(isoUtc, offsetMinutes) {
        stubHappyPath({ createsSession: true, timezoneOffset: offsetMinutes });
        const { res } = makeRes();
        return UploadController.processUpload(makeReq({
            eml: 'user@x.com',
            session: 'abc-123',
            time: String(Date.parse(isoUtc)),
        }), res).then(() => sessionUpdateCalls[0].name);
    }

    test('UTC+8 14:30 UTC → Trip 25082026 10:30PM', async () => {
        assert.strictEqual(await nameFor('2026-08-25T14:30:00Z', 480), 'Trip 25082026 10:30PM');
    });

    test('UTC+0 midnight → Trip 01012026 12:00AM', async () => {
        assert.strictEqual(await nameFor('2026-01-01T00:00:00Z', 0), 'Trip 01012026 12:00AM');
    });

    test('UTC-5 09:15 UTC → Trip 25082026 4:15AM (hours unpadded, matching prod format)', async () => {
        assert.strictEqual(await nameFor('2026-08-25T09:15:00Z', -300), 'Trip 25082026 4:15AM');
    });

    test('UTC+12 23:59 UTC rolls to next day → Trip 26082026 11:59AM', async () => {
        assert.strictEqual(await nameFor('2026-08-25T23:59:00Z', 720), 'Trip 26082026 11:59AM');
    });

    test('noon UTC with no offset → Trip 15062026 12:00PM', async () => {
        assert.strictEqual(await nameFor('2026-06-15T12:00:00Z', 0), 'Trip 15062026 12:00PM');
    });

    test('existing session is not renamed', async () => {
        stubHappyPath({ createsSession: false, timezoneOffset: 480 });
        const { res } = makeRes();
        await UploadController.processUpload(makeReq({
            eml: 'user@x.com',
            session: 'abc-123',
            time: String(Date.parse('2026-08-25T14:30:00Z')),
        }), res);
        assert.strictEqual(sessionUpdateCalls.length, 0);
    });
});

// ── resolveUser — exported module-private helper, tested directly ──────

describe('Upload hardening – resolveUser lowercases at the identity boundary', () => {
    test('mixed-case eml reaches findOne lowercased', async () => {
        stubHappyPath();
        const found = await UploadController.resolveUser('User@X.COM');
        assert.ok(found, 'user returned');
        assert.strictEqual(found.id, 1);
        assert.deepStrictEqual(findOneCalls, [{ where: { email: 'user@x.com' } }]);
    });

    test('cache key is normalized — mixed and lowercase share one entry', async () => {
        stubHappyPath();
        await UploadController.resolveUser('User@X.COM'); // DB miss→hit path
        await UploadController.resolveUser('user@x.com'); // must be a cache HIT
        assert.strictEqual(findOneCalls.length, 1, 'second lookup served from normalized cache key');
        assert.ok(mockUserCache.store.has('user@x.com'));
        assert.strictEqual(mockUserCache.store.size, 1, 'no split cache entries for case variants');
    });

    test('negative result is cached as null under the lowered key', async () => {
        stubHappyPath({ user: null });
        const miss = await UploadController.resolveUser('Ghost@X.COM');
        assert.strictEqual(miss, null);
        assert.strictEqual(mockUserCache.store.get('ghost@x.com'), null);
        await UploadController.resolveUser('ghost@x.com');
        assert.strictEqual(findOneCalls.length, 1, 'negative cached — no second DB call');
    });

    test('falsy eml short-circuits without touching the DB', async () => {
        stubHappyPath();
        assert.strictEqual(await UploadController.resolveUser(undefined), null);
        assert.strictEqual(await UploadController.resolveUser(''), null);
        assert.strictEqual(findOneCalls.length, 0);
    });
});

// ── User model email hook — REAL factory code, stubbed sequelize ───────
// models/User.js only requires Joi + bcrypt at top level, so requiring it is
// safe. We invoke its exported factory with a fake sequelize/dataTypes pair
// and capture the options object passed to sequelize.define. That gives us
// both the wiring (hook arrays) and the actual normalizeEmail implementation
// from production — no local copy of the logic.

describe('Upload hardening – User model normalizeEmail hook (production code)', () => {
    const factory = require('../models/User');

    const captured = {};
    const fakeModel = function User() {}; // sequelize.define returns the model constructor
    const fakeSequelize = {
        define(name, attributes, options) {
            captured.name = name;
            captured.attributes = attributes;
            captured.options = options;
            return fakeModel;
        },
    };
    const fakeDataTypes = {
        STRING: 'STRING',
        ARRAY: (inner) => ['ARRAY', inner],
    };
    const UserModel = factory(fakeSequelize, fakeDataTypes);

    const hooks = captured.options.hooks;
    const normalizeHook = hooks.beforeCreate.find((fn) => fn.name === 'normalizeEmail');

    test('factory registers normalizeEmail alongside hashPassword on create', () => {
        assert.strictEqual(captured.name, 'User');
        assert.deepStrictEqual(
            hooks.beforeCreate.map((fn) => fn.name).filter((n) => n === 'hashPassword' || n === 'normalizeEmail'),
            ['hashPassword', 'normalizeEmail']
        );
    });

    test('factory registers normalizeEmail alongside hashPassword on update', () => {
        assert.deepStrictEqual(
            hooks.beforeUpdate.map((fn) => fn.name).filter((n) => n === 'hashPassword' || n === 'normalizeEmail'),
            ['hashPassword', 'normalizeEmail']
        );
    });

    test('hook lowercases a changed mixed-case email', async () => {
        const instance = { email: 'User@Example.COM', changed: (field) => field === 'email' };
        await normalizeHook(instance);
        assert.strictEqual(instance.email, 'user@example.com');
    });

    test('hook leaves already-lowercase email unchanged', async () => {
        const instance = { email: 'user@example.com', changed: (field) => field === 'email' };
        await normalizeHook(instance);
        assert.strictEqual(instance.email, 'user@example.com');
    });

    test('hook does nothing when email was not changed', async () => {
        const instance = { email: 'User@Example.COM', changed: () => false };
        await normalizeHook(instance);
        assert.strictEqual(instance.email, 'User@Example.COM');
    });

    test('hook tolerates a null email', async () => {
        const instance = { email: null, changed: (field) => field === 'email' };
        await normalizeHook(instance);
        assert.strictEqual(instance.email, null);
    });

    test('structural guard: source wires both hook chains explicitly', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'models', 'User.js'), 'utf8');
        assert.match(src, /beforeCreate:\s*\[hashPassword,\s*normalizeEmail\]/);
        assert.match(src, /beforeUpdate:\s*\[hashPassword,\s*normalizeEmail\]/);
    });

    // Sanity: the factory still returns the model object with its API intact.
    test('factory output exposes validate + comparePassword + associate', () => {
        assert.strictEqual(typeof UserModel.validate, 'function');
        assert.strictEqual(typeof UserModel.prototype.comparePassword, 'function');
        assert.strictEqual(typeof UserModel.associate, 'function');
    });
});

// ── UserCache.del() — real lib/userCache (captured before mock injection) ──

describe('Upload hardening – userCache.del()', () => {
    const { UserCache } = realUserCache;

    test('del() removes the entry so get() returns undefined', () => {
        const cache = new UserCache({ ttl: 10000, max: 10 });
        cache.set('user@test.com', { id: 1 });
        assert.deepStrictEqual(cache.get('user@test.com'), { id: 1 });

        cache.del('user@test.com');
        assert.strictEqual(cache.get('user@test.com'), undefined);
    });

    test('del() on nonexistent key is a no-op', () => {
        const cache = new UserCache({ ttl: 10000, max: 10 });
        cache.del('nonexistent');
        assert.strictEqual(cache.get('nonexistent'), undefined);
    });
});

// ── Bearer-token gate (UPLOAD_API_TOKEN configured) ─────────────────
// The gate (UploadController.js:36-51) is only active when the runtime holds a
// configured token. stubHappyPath() turns the gate OFF (token = null); these
// cases turn it back ON through the mockRuntime.token seam and drive the
// processUpload entry point so the real header checks + crypto comparison run.
// A spy on crypto.timingSafeEqual proves the length pre-check short-circuits
// before the (expensive, panic-prone) constant-time compare runs.

describe('Upload hardening – bearer-token gate', () => {
    const CONFIGURED_TOKEN = 'aabbccdd11223344'; // 16 chars

    function makeAuthReq(query, authorization) {
        const req = makeReq(query);
        if (authorization !== undefined) req.headers.authorization = authorization;
        return req;
    }

    // Count timingSafeEqual invocations; restore the real fn afterwards so
    // other suites in this file are unaffected.
    function spyTimingSafeEqual() {
        const original = crypto.timingSafeEqual;
        const spyCalls = { count: 0 };
        crypto.timingSafeEqual = (a, b) => {
            spyCalls.count += 1;
            return original(a, b);
        };
        return {
            spyCalls,
            restore() { crypto.timingSafeEqual = original; },
        };
    }

    const VALID_QUERY = { eml: 'user@x.com', session: 'abc-123', v: 'Car' };

    test('configured token + missing Authorization header returns 401 before any DB access', async () => {
        stubHappyPath();
        mockRuntime.token = CONFIGURED_TOKEN;
        const { res, calls } = makeRes();
        await UploadController.processUpload(makeAuthReq(VALID_QUERY), res);
        assert.strictEqual(calls.statusCode, 401);
        assert.deepStrictEqual(calls.body, {
            error: 'Authorization header required',
            hint: 'Set Authorization: Bearer <your-token> in Torque Pro',
        });
        assert.strictEqual(findOneCalls.length, 0, 'gate must reject before resolveUser hits the DB');
    });

    test('configured token + non-Bearer header returns 401', async () => {
        stubHappyPath();
        mockRuntime.token = CONFIGURED_TOKEN;
        const { res, calls } = makeRes();
        await UploadController.processUpload(makeAuthReq(VALID_QUERY, `Token ${CONFIGURED_TOKEN}`), res);
        assert.strictEqual(calls.statusCode, 401);
        assert.strictEqual(findOneCalls.length, 0);
    });

    test('configured token + wrong token of equal length returns 401 via timingSafeEqual', async () => {
        stubHappyPath();
        mockRuntime.token = CONFIGURED_TOKEN;
        const spy = spyTimingSafeEqual();
        try {
            const wrong = 'X'.repeat(CONFIGURED_TOKEN.length);
            const { res, calls } = makeRes();
            await UploadController.processUpload(makeAuthReq(VALID_QUERY, `Bearer ${wrong}`), res);
            assert.strictEqual(calls.statusCode, 401);
            assert.deepStrictEqual(calls.body, { error: 'Invalid upload token' });
            assert.strictEqual(spy.spyCalls.count, 1, 'equal-length wrong token must reach timingSafeEqual and fail');
            assert.strictEqual(findOneCalls.length, 0);
        } finally {
            spy.restore();
        }
    });

    test('configured token + correct token passes the gate and ingests', async () => {
        stubHappyPath();
        mockRuntime.token = CONFIGURED_TOKEN;
        const { res, calls } = makeRes();
        await UploadController.processUpload(makeAuthReq(VALID_QUERY, `Bearer ${CONFIGURED_TOKEN}`), res);
        assert.strictEqual(calls.statusCode, 200);
        assert.strictEqual(calls.body, 'OK!');
        assert.strictEqual(findOneCalls.length, 1, 'resolveUser runs once the gate passes');
        assert.strictEqual(ingestCalls.length, 1, 'ingest is reached after authentication');
    });

    test('configured token + length-mismatched header returns 401 WITHOUT calling timingSafeEqual', async () => {
        stubHappyPath();
        mockRuntime.token = CONFIGURED_TOKEN;
        const spy = spyTimingSafeEqual();
        try {
            const { res, calls } = makeRes();
            // Short garbage: the length pre-check must reject before the
            // constant-time compare is ever invoked.
            await UploadController.processUpload(makeAuthReq(VALID_QUERY, 'Bearer x'), res);
            assert.strictEqual(calls.statusCode, 401);
            assert.deepStrictEqual(calls.body, { error: 'Invalid upload token' });
            assert.strictEqual(spy.spyCalls.count, 0, 'length mismatch must short-circuit timingSafeEqual');
            assert.strictEqual(findOneCalls.length, 0);
        } finally {
            spy.restore();
        }
    });
});
