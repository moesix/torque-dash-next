'use strict';

// Hot-path TTL cache behavior — tested against PRODUCTION code only:
//   - config/passport.js deserializeUser (user-by-id cache)
//   - controllers/UserController.changePassword (cache invalidation wiring)
//   - controllers/UploadController.processUpload (vehicle + torque-session caches)
// Models/ingestBuffer/runtime are replaced via require.cache BEFORE
// the production modules load; lib/userCache stays REAL so the caches under
// test are the actual UserCache instances production constructs.

// Set dummy env vars BEFORE any module loading so config.js doesn't throw
// (same pattern as test/uploadHardening.test.js).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const passportPkg = require('passport');

// ── Pre-populate require.cache for everything the controllers pull in ─────

function inject(resolvedPath, exportsObj) {
    require.cache[resolvedPath] = {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        exports: exportsObj,
    };
}

const mockModels = {
    User: { findByPk: async () => null, findOne: async () => null },
    Session: { findOrCreate: async () => [{ id: 0 }, false] },
    Vehicle: { findOne: async () => null },
    Settings: { getSingleton: async () => ({ timezoneOffset: 0 }) },
};
inject(require.resolve('../models'), mockModels);

const ingestRows = [];
const mockIngestBuffer = { ingest(row) { ingestRows.push(row); } };
inject(require.resolve('../services/ingestBuffer'), mockIngestBuffer);

const mockRuntime = {
    token: null,
    getUploadApiToken() { return mockRuntime.token; },
};
inject(require.resolve('../config/runtime'), mockRuntime);

// ── Load PRODUCTION modules against the mocks ──────────────────────────────
require('../config/passport')(passportPkg); // registers serialize/deserializeUser
const { userByIdCache } = require('../config/passport');
const realUserCache = require('../lib/userCache'); // real lib (not injected)
const UploadController = require('../controllers/UploadController');
const UserController = require('../controllers/UserController');

// ── Shared mutable fixtures (reset per test) ───────────────────────────────
let findByPkCalls;
let dbUser;               // what User.findByPk returns during the current test
let vehicleFindOneCalls;
let vehicleFindOneImpl;   // per-test Vehicle.findOne behavior
let findOrCreateCalls;
let findOrCreateImpl;     // per-test Session.findOrCreate behavior

function makeModelUser(id, tokenVersion, overrides = {}) {
    return {
        id,
        email: `user${id}@test.io`,
        tokenVersion,
        ...overrides,
        get() { return { id: this.id, email: this.email, tokenVersion: this.tokenVersion }; },
    };
}

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

async function deserialize(session) {
    return new Promise((resolve) => {
        passportPkg.deserializeUser(session, (err, user) => resolve({ err, user }));
    });
}

beforeEach(() => {
    findByPkCalls = [];
    dbUser = null;
    vehicleFindOneCalls = [];
    vehicleFindOneImpl = async () => null;
    findOrCreateCalls = [];
    findOrCreateImpl = async () => [{ id: 0 }, false];
    mockModels.User.findByPk = async (id) => { findByPkCalls.push(id); return dbUser; };
    // Upload tests address users as owner<id>@test.io — resolve them by email.
    mockModels.User.findOne = async (args) => {
        const m = /owner(\d+)@test\.io/.exec(args.where.email);
        return m ? { id: Number(m[1]) } : null;
    };
    mockModels.Vehicle.findOne = async (args) => { vehicleFindOneCalls.push(args); return vehicleFindOneImpl(args); };
    mockModels.Session.findOrCreate = async (args) => {
        findOrCreateCalls.push(args);
        return findOrCreateImpl(args);
    };
    mockModels.Settings.getSingleton = async () => ({ timezoneOffset: 0 });

    userByIdCache.store.clear();      // passport's user-by-id cache
    realUserCache.store.clear();      // resolveUser's email cache (shared singleton)
    mockRuntime.token = null;         // bearer-token gate OFF
    ingestRows.length = 0;
});

// ── 1. deserializeUser – user-by-id cache (PRODUCTION handler) ────────────

describe('deserializeUser – production cache', () => {
    test('cache hit avoids findByPk — one DB call across two invocations', async () => {
        dbUser = makeModelUser(42, 0);

        const first = await deserialize({ id: 42, tv: 0 });
        assert.ifError(first.err);
        assert.strictEqual(first.user.id, 42);
        assert.strictEqual(findByPkCalls.length, 1);

        const second = await deserialize({ id: 42, tv: 0 });
        assert.ifError(second.err);
        assert.deepStrictEqual(second.user, first.user, 'cached copy matches fresh .get() output');
        assert.strictEqual(findByPkCalls.length, 1, 'findByPk must not run again within the TTL window');
    });

    test('tokenVersion mismatch rejects EVEN on a cache hit', async () => {
        dbUser = makeModelUser(1, 0);
        await deserialize({ id: 1, tv: 0 }); // populates cache (findByPk: 1)
        assert.strictEqual(findByPkCalls.length, 1);

        // Password changed in the DB (tokenVersion bumped) but the cache was
        // NOT invalidated — the stale-session rejection must still happen and
        // must be decided from CACHED data (no fresh read to consult).
        dbUser = makeModelUser(1, 1);

        const rejected = await deserialize({ id: 1, tv: 1 });
        assert.ifError(rejected.err);
        assert.strictEqual(rejected.user, false, 'stale epoch rejected even though cache holds a user');
        assert.strictEqual(findByPkCalls.length, 1, 'rejection decided without another DB hit');
    });

    test('negative result cached — unknown id hits findByPk once', async () => {
        dbUser = null;

        const first = await deserialize({ id: 999, tv: 0 });
        assert.strictEqual(first.user, false);
        assert.strictEqual(findByPkCalls.length, 1);

        const second = await deserialize({ id: 999, tv: 0 });
        assert.strictEqual(second.user, false);
        assert.strictEqual(findByPkCalls.length, 1, 'misses are negative-cached within the TTL window');
    });

    test('changePassword invalidates the entry — next deserialize hits the DB', async () => {
        // Phase 1: warm the deserializeUser cache for user 9.
        dbUser = makeModelUser(9, 0);
        const warmed = await deserialize({ id: 9, tv: 0 });
        assert.strictEqual(warmed.user.id, 9);
        assert.strictEqual(findByPkCalls.length, 1);
        assert.notStrictEqual(userByIdCache.get(9), undefined, 'entry present before password change');

        // Phase 2: run the REAL changePassword against mocked model plumbing.
        let updatePatches = [];
        dbUser = {
            id: 9,
            email: 'user9@test.io',
            comparePassword: async () => true,
            update: async (patch) => { updatePatches.push(patch); },
        };
        const req = {
            body: { currentPassword: 'old-secret', newPassword: 'brand-new-pass' },
            user: { id: 9 },
            session: { regenerate: (cb) => cb(null) },
            logIn: (u, cb) => cb(null),
        };
        const { res, calls } = makeRes();
        await UserController.changePassword(req, res);
        assert.strictEqual(calls.body.ok, true, 'changePassword completed');
        assert.deepStrictEqual(updatePatches, [{ password: 'brand-new-pass' }, { tokenVersion: 1 }]);
        const dbCallsAfterChange = findByPkCalls.length; // warm-up + changePassword's own read

        // THE assertion: the wiring deleted the cache entry for this user.
        assert.strictEqual(userByIdCache.get(9), undefined, 'changePassword must del() the user cache entry');

        // Next deserialize goes back to the DB (fresh data served).
        dbUser = makeModelUser(9, 0, { email: 'rotated-credentials@test.io' });
        const after = await deserialize({ id: 9, tv: 0 });
        assert.strictEqual(after.user.email, 'rotated-credentials@test.io', 'fresh DB row served after invalidation');
        assert.strictEqual(findByPkCalls.length, dbCallsAfterChange + 1, 'invalidation forces a real DB re-read');
    });
});

// ── 2. Vehicle caches through the REAL processUpload ──────────────────────
// The controller's vehicle/session caches are module-private instances, so
// each test uses UNIQUE user ids — keys (`vn:{userId}:…`, `vd:{userId}`,
// `s:{userId}:{session}`) can then never collide across tests.

describe('vehicleCache – negative caching via processUpload', () => {
    test('unknown v is negative-cached — repeat frame makes zero extra vehicle queries', async () => {
        vehicleFindOneImpl = async () => null; // no named match, no default either

        const q1 = makeReq({ eml: 'owner101@test.io', session: 'dev-a', v: 'GhostCar' });
        const r1 = makeRes();
        await UploadController.processUpload(q1, r1.res);
        assert.strictEqual(r1.calls.statusCode, 200);
        assert.strictEqual(vehicleFindOneCalls.length, 2, 'first frame: one lookup by name + one default fallback');

        const q2 = makeReq({ eml: 'owner101@test.io', session: 'dev-a', v: 'GhostCar' });
        const r2 = makeRes();
        await UploadController.processUpload(q2, r2.res);
        assert.strictEqual(r2.calls.statusCode, 200);
        assert.strictEqual(vehicleFindOneCalls.length, 2, 'second frame fully served from negative cache');

        // Keys are scoped per user and purpose.
        assert.ok(vehicleFindOneCalls.some((a) => a.where.name === 'GhostCar'));
        assert.ok(vehicleFindOneCalls.some((a) => a.where.isDefault === true));
    });
});

describe('vehicleCache – default fallback + positive name caching via processUpload', () => {
    test('default vehicle cached under vd:key; known name cached under vn:key', async () => {
        vehicleFindOneImpl = async (args) => {
            if (args.where.isDefault) return { id: 31 };
            if (args.where.name === 'Herbie') return { id: 32 };
            return null;
        };

        // Frame 1: no v → single vd: lookup. (Distinct session strings so each
        // frame takes the session miss path and reaches findOrCreate.)
        await UploadController.processUpload(makeReq({ eml: 'owner102@test.io', session: 'dev-b1' }), makeRes().res);
        assert.strictEqual(vehicleFindOneCalls.length, 1, 'only the default lookup ran');

        // Frame 2: no v → vd: cache hit, zero queries.
        await UploadController.processUpload(makeReq({ eml: 'owner102@test.io', session: 'dev-b2' }), makeRes().res);
        assert.strictEqual(vehicleFindOneCalls.length, 1, 'default fallback served from vd: cache');
        assert.deepStrictEqual(
            findOrCreateCalls[findOrCreateCalls.length - 1].defaults,
            { userId: 102, vehicleId: 31 },
            'cached default resolved to its numeric FK'
        );

        // Frame 3: named vehicle found and cached under vn:key.
        await UploadController.processUpload(makeReq({ eml: 'owner102@test.io', session: 'dev-b3', v: 'Herbie' }), makeRes().res);
        assert.strictEqual(vehicleFindOneCalls.length, 2, 'one additional name lookup');

        // Frame 4: same name → vn: cache hit, zero queries.
        await UploadController.processUpload(makeReq({ eml: 'owner102@test.io', session: 'dev-b4', v: 'Herbie' }), makeRes().res);
        assert.strictEqual(vehicleFindOneCalls.length, 2, 'named lookup served from vn: cache');
        assert.deepStrictEqual(
            findOrCreateCalls[findOrCreateCalls.length - 1].defaults,
            { userId: 102, vehicleId: 32 }
        );
    });
});

// ── 3. Torque-session cache through the REAL processUpload ────────────────

describe('sessionCache – positive-only caching via processUpload', () => {
    test('hit within TTL skips findOrCreate entirely', async () => {
        findOrCreateImpl = async () => [{ id: 77, update: async () => {} }, true];

        await UploadController.processUpload(makeReq({ eml: 'owner201@test.io', session: 'dev-1' }), makeRes().res);
        assert.strictEqual(findOrCreateCalls.length, 1);
        assert.deepStrictEqual(findOrCreateCalls[0].where, { sessionId: 'dev-1', userId: 201 });

        await UploadController.processUpload(makeReq({ eml: 'owner201@test.io', session: 'dev-1' }), makeRes().res);
        assert.strictEqual(findOrCreateCalls.length, 1, 'second frame resolved from s:{user}:{session} cache');

        // Both frames buffered the SAME numeric FK.
        assert.deepStrictEqual(ingestRows.map((r) => r.sessionId), [77, 77]);
    });

    test('different user ⇒ different key ⇒ separate findOrCreate', async () => {
        findOrCreateImpl = async (args) => [{ id: args.where.userId * 10, update: async () => {} }, true];

        await UploadController.processUpload(makeReq({ eml: 'owner202@test.io', session: 'shared-device' }), makeRes().res);
        await UploadController.processUpload(makeReq({ eml: 'owner203@test.io', session: 'shared-device' }), makeRes().res);

        assert.strictEqual(findOrCreateCalls.length, 2, 'identical device string must NOT be shared across users');
        assert.deepStrictEqual(findOrCreateCalls.map((c) => c.where.userId), [202, 203]);
    });

    test('distinct session strings each take the miss path (positive-only)', async () => {
        findOrCreateImpl = async () => [{ id: 55, update: async () => {} }, true];

        await UploadController.processUpload(makeReq({ eml: 'owner205@test.io', session: 'q1' }), makeRes().res);
        await UploadController.processUpload(makeReq({ eml: 'owner205@test.io', session: 'q2' }), makeRes().res);

        assert.strictEqual(findOrCreateCalls.length, 2, 'every unseen device string resolves in the DB');
    });

    test('wasCreated survives the cache path — naming runs exactly once', async () => {
        const sessionUpdateCalls = [];
        const freshSession = { id: 88, update: async (patch) => { sessionUpdateCalls.push(patch); } };
        let calls = 0;
        findOrCreateImpl = async () => {
            calls += 1;
            return [freshSession, calls === 1]; // created only on the very first frame
        };

        const time = String(Date.parse('2026-08-25T14:30:00Z'));
        const q1 = makeReq({ eml: 'owner204@test.io', session: 'fresh-trip', time });
        const r1 = makeRes();
        await UploadController.processUpload(q1, r1.res);
        assert.strictEqual(r1.calls.statusCode, 200);
        assert.strictEqual(sessionUpdateCalls.length, 1, 'new session gets its Trip name');
        assert.match(sessionUpdateCalls[0].name, /^Trip \d{8} \d{1,2}:\d{2}(AM|PM)$/);

        // Cache-hit frame: findOrCreate untouched AND the naming block must
        // not re-run (wasCreated was captured before the cache took over).
        await UploadController.processUpload(makeReq({ eml: 'owner204@test.io', session: 'fresh-trip', time }), makeRes().res);
        assert.strictEqual(findOrCreateCalls.length, 1, 'hit path skipped findOrCreate');
        assert.strictEqual(sessionUpdateCalls.length, 1, 'naming NOT re-triggered for an existing session');
        assert.deepStrictEqual(ingestRows.map((r) => r.sessionId), [88, 88]);
    });
});

// ── 4. Real lib/userCache semantics backing the hot paths ─────────────────

describe('vehicleCache – negative and positive caching', () => {
    const { UserCache } = require('../lib/userCache');

    test('vehicle cache returns null for negative entries', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        cache.set('v:1:NonExistent', null); // negative cache

        const result = cache.get('v:1:NonExistent');
        assert.strictEqual(result, null, 'should return null for negative vehicle cache hit');

        // Undefined means "not cached"
        assert.strictEqual(cache.get('v:1:OtherVehicle'), undefined);
    });

    test('vehicle cache returns cached vehicle on second lookup', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        const vehicle = { id: 10, name: 'My Car', userId: 1 };

        cache.set('v:1:My Car', vehicle);
        const result = cache.get('v:1:My Car');
        assert.deepStrictEqual(result, vehicle);
    });

    test('default vehicle cache works independently', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        const defaultVehicle = { id: 5, name: 'Default', isDefault: true };

        cache.set('vd:1', defaultVehicle);
        assert.deepStrictEqual(cache.get('vd:1'), defaultVehicle);
        assert.strictEqual(cache.get('vd:2'), undefined, 'different user has no default cached');
    });
});

describe('sessionCache – positive lookup caching', () => {
    const { UserCache } = require('../lib/userCache');

    test('session cache returns cached session on second lookup', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        const sess = { id: 99, sessionId: 'abc', userId: 1 };

        cache.set('s:abc:1', sess);
        const result = cache.get('s:abc:1');
        assert.deepStrictEqual(result, sess);
    });

    test('session cache does not cache negatives', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        const sess = { id: 100, sessionId: 'xyz', userId: 2 };
        cache.set('s:xyz:2', sess);

        // Different user/session should be undefined (never negative-cached)
        assert.strictEqual(cache.get('s:xyz:3'), undefined);
    });

    test('session cache key includes userId for isolation', () => {
        const cache = new UserCache({ ttl: 60000, max: 100 });
        const sess1 = { id: 1, sessionId: 'same-session', userId: 1 };
        const sess2 = { id: 2, sessionId: 'same-session', userId: 2 };

        cache.set('s:same-session:1', sess1);
        cache.set('s:same-session:2', sess2);

        assert.deepStrictEqual(cache.get('s:same-session:1'), sess1);
        assert.deepStrictEqual(cache.get('s:same-session:2'), sess2);
    });
});
