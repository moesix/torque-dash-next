'use strict';

// Plan 110: behavioral coverage for the login flow — config/passport.js
// LocalStrategy verify callback (real passport + real strategy, mocked models),
// the UserController.login wrapper (real passport.authenticate middleware
// composition), UserController.register (incl. the plan-099 first-user admin
// bootstrap), and middleware/auth.js 401 JSON for unauthenticated API calls.
//
// Harness patterns: sessionLifecycle.test.js (real passport + require.cache
// models), surfaceTightening.test.js (direct controller invocation with stub
// req/res), analysisJournal.test.js / adminGate.test.js (HTTP withServer).

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';
// The deploy-time registration kill switch and env-sourced upload token are
// toggled inside specific tests — start from a clean slate.
delete process.env.DISABLE_REGISTRATION;
delete process.env.UPLOAD_API_TOKEN;

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const passport = require('passport');

// ── Mutable model behavior (reset per test) ─────────────────────────

const findOneCalls = [];
const createCalls = [];
let settingsRow;
let userFindOneResult = null;
let userCountResult = 0;
let validateResult = { error: null };
let findOneError = null;

const mockModels = {
    User: {
        findOne: async (opts) => {
            findOneCalls.push(opts);
            if (findOneError) throw findOneError;
            return userFindOneResult;
        },
        findByPk: async () => null,
        count: async () => userCountResult,
        create: async (attrs) => {
            createCalls.push(attrs);
            return { id: 1, ...attrs };
        },
        validate: () => validateResult,
    },
    Settings: {
        getSingleton: async () => settingsRow,
        invalidateCache: () => {},
        upsert: async () => ({}),
    },
    Session: {
        findOne: async () => null,
        findAll: async () => [],
        count: async () => 0,
        create: async () => ({}),
        destroy: async () => 0,
    },
    Log: {
        count: async () => 0,
        findAll: async () => [],
        destroy: async () => 0,
    },
    Analysis: {
        findOne: async () => null,
        findAll: async () => [],
        count: async () => 0,
        create: async () => ({}),
        destroy: async () => 0,
    },
    Vehicle: {
        findOne: async () => null,
        findAll: async () => [],
    },
    sequelize: {
        query: async () => [],
        QueryTypes: { SELECT: 'SELECT' },
        fn: () => {},
        col: () => {},
    },
    Sequelize: {
        Op: {
            in: Symbol('in'),
            and: Symbol('and'),
            gt: Symbol('gt'),
            lte: Symbol('lte'),
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

// Mock heavy LLM-analysis dependencies so requiring routes/api.js stays
// side-effect free (same set as adminGate.test.js).
const llmProvidersPath = require.resolve('../lib/llmProviders');
require.cache[llmProvidersPath] = {
    id: llmProvidersPath,
    filename: llmProvidersPath,
    loaded: true,
    exports: {
        analyze: async () => ({ response: { body: '' }, abortController: { abort: () => {} } }),
        streamEvents: async function* () {},
    },
};
const llmPromptPath = require.resolve('../lib/llmPrompt');
require.cache[llmPromptPath] = {
    id: llmPromptPath,
    filename: llmPromptPath,
    loaded: true,
    exports: { buildAnalysisPrompt: () => 'test prompt' },
};
const pidRegistryPath = require.resolve('../lib/pidRegistry');
require.cache[pidRegistryPath] = {
    id: pidRegistryPath,
    filename: pidRegistryPath,
    loaded: true,
    exports: { discoverPidKeys: async () => ({}) },
};

// ── Load the REAL passport config (registers the local strategy) and then
// the controller, which binds to the same mock models + passport instance.
require('../config/passport')(passport);
const UserController = require('../controllers/UserController');

// Real router for the middleware/auth.js check (lazy so a config failure skips
// only the HTTP describe, same as analysisJournal).
let apiRouter;
try {
    apiRouter = require('../routes/api');
} catch (err) {
    console.error('[loginFlow.test] routes/api.js failed to load:', err.message);
    apiRouter = null;
}

function makeUser(overrides = {}) {
    return {
        id: 1,
        email: 'user@example.com',
        comparePassword: async () => true,
        ...overrides,
    };
}

beforeEach(() => {
    findOneCalls.length = 0;
    createCalls.length = 0;
    userFindOneResult = null;
    userCountResult = 0;
    validateResult = { error: null };
    findOneError = null;
    settingsRow = { disableRegistration: false };
    delete process.env.DISABLE_REGISTRATION;
});

afterEach(() => {
    delete process.env.DISABLE_REGISTRATION;
});

// ── LocalStrategy verify callback — production strategy, direct drive ──

describe('LocalStrategy verify callback (config/passport.js)', () => {
    function runVerify(email, password) {
        return new Promise((resolve) => {
            passport._strategies.local._verify(email, password, (...args) => resolve(args));
        });
    }

    test('correct credentials call done(null, user)', async () => {
        const user = makeUser();
        userFindOneResult = user;
        const args = await runVerify('user@example.com', 'password123');
        assert.strictEqual(args[0], null);
        assert.strictEqual(args[1], user);
        assert.strictEqual(args.length, 2, 'no info object on success');
    });

    test('wrong password calls done(null, false, message)', async () => {
        userFindOneResult = makeUser({ comparePassword: async () => false });
        const args = await runVerify('user@example.com', 'wrongpass');
        assert.strictEqual(args[0], null);
        assert.strictEqual(args[1], false);
        assert.deepStrictEqual(args[2], { message: 'Incorrect username or password.' });
    });

    test('unknown email calls done(null, false, message)', async () => {
        userFindOneResult = null;
        const args = await runVerify('ghost@example.com', 'password123');
        assert.strictEqual(args[0], null);
        assert.strictEqual(args[1], false);
        assert.deepStrictEqual(args[2], { message: 'Incorrect username or password.' });
    });

    test('a thrown DB error calls done(err, false)', async () => {
        findOneError = new Error('db unavailable');
        const args = await runVerify('user@example.com', 'password123');
        assert.ok(args[0] instanceof Error);
        assert.strictEqual(args[0].message, 'db unavailable');
        assert.strictEqual(args[1], false);
    });

    test('email is lowercased before the findOne lookup', async () => {
        userFindOneResult = makeUser();
        const args = await runVerify('User@Example.COM', 'password123');
        assert.strictEqual(args[1], userFindOneResult, 'login succeeds for mixed-case input');
        assert.deepStrictEqual(findOneCalls, [{ where: { email: 'user@example.com' } }]);
    });
});

// ── UserController.login wrapper (real passport.authenticate chain) ──

describe('UserController.login wrapper', () => {
    // login() returns before passport's async verify chain finishes (the
    // LocalStrategy awaits User.findOne + comparePassword), so the response is
    // emitted on a later microtask. resolveDone fires when the wrapper reaches
    // a terminal action (res.json or next(err)) and tests await it.
    function makeLoginHarness({ body } = {}) {
        const calls = {};
        const resCalls = { statusCode: null, body: null };
        let resolveDone;
        const donePromise = new Promise((resolve) => { resolveDone = resolve; });
        const req = {
            body: body || { email: 'user@example.com', password: 'password123' },
            logIn(user, cb) {
                calls.loginUser = user;
                cb(null);
            },
        };
        const res = {
            status(code) { resCalls.statusCode = code; return res; },
            json(obj) { resCalls.body = obj; resolveDone(); return res; },
        };
        const nextCalls = { args: [] };
        const next = (err) => { nextCalls.args.push(err); resolveDone(); };
        return { req, res, resCalls, next, nextCalls, calls, donePromise };
    }

    test('successful credentials respond { ok: true } and log the user in', async () => {
        userFindOneResult = makeUser();
        const h = makeLoginHarness();
        UserController.login(h.req, h.res, h.next);
        await h.donePromise;
        assert.deepStrictEqual(h.resCalls.body, { ok: true });
        assert.strictEqual(h.calls.loginUser.id, 1, 'req.logIn receives the authenticated user');
        assert.strictEqual(h.nextCalls.args.length, 0);
    });

    test('bad password responds 401 with the generic strategy message', async () => {
        userFindOneResult = makeUser({ comparePassword: async () => false });
        const h = makeLoginHarness();
        UserController.login(h.req, h.res, h.next);
        await h.donePromise;
        assert.strictEqual(h.resCalls.statusCode, 401);
        assert.deepStrictEqual(h.resCalls.body, { error: 'Incorrect username or password.' });
        assert.strictEqual(h.calls.loginUser, undefined, 'no logIn on failure');
    });

    test('unknown email responds 401 (no account enumeration)', async () => {
        userFindOneResult = null;
        const h = makeLoginHarness();
        UserController.login(h.req, h.res, h.next);
        await h.donePromise;
        assert.strictEqual(h.resCalls.statusCode, 401);
        assert.deepStrictEqual(h.resCalls.body, { error: 'Incorrect username or password.' });
    });

    test('a strategy error is forwarded to next()', async () => {
        findOneError = new Error('db unavailable');
        const h = makeLoginHarness();
        UserController.login(h.req, h.res, h.next);
        await h.donePromise;
        assert.strictEqual(h.nextCalls.args.length, 1, 'next must be called with the error');
        assert.strictEqual(h.nextCalls.args[0].message, 'db unavailable');
        assert.strictEqual(h.resCalls.body, null, 'no JSON response on internal error');
    });

    test('missing credentials short-circuit to 401 without a DB hit', async () => {
        const h = makeLoginHarness({ body: {} });
        UserController.login(h.req, h.res, h.next);
        await h.donePromise;
        assert.strictEqual(h.resCalls.statusCode, 401);
        assert.deepStrictEqual(h.resCalls.body, { error: 'Missing credentials' });
        assert.strictEqual(findOneCalls.length, 0, 'no user lookup without credentials');
    });
});

// ── UserController.register ─────────────────────────────────────────

describe('UserController.register', () => {
    function makeRegisterRes() {
        const calls = { statusCode: null, body: null };
        const res = {
            status(code) { calls.statusCode = code; return res; },
            json(obj) { calls.body = obj; return res; },
        };
        return { res, calls };
    }

    test('happy path returns 201 and creates the user lowercased', async () => {
        userCountResult = 0;
        const req = { body: { email: 'New@Example.COM', password: 'password123' } };
        const { res, calls } = makeRegisterRes();
        await UserController.register(req, res);

        assert.strictEqual(calls.statusCode, 201);
        assert.deepStrictEqual(calls.body, { ok: true });
        assert.deepStrictEqual(findOneCalls, [{ where: { email: 'new@example.com' } }],
            'duplicate-check findOne must use the lowercased email');
        assert.strictEqual(createCalls.length, 1);
        assert.deepStrictEqual(createCalls[0], {
            email: 'new@example.com',
            password: 'password123',
            isAdmin: true,
        }, 'first registered user is bootstrapped as admin (plan 099)');
    });

    test('a later user is created with isAdmin: false', async () => {
        userCountResult = 1;
        const req = { body: { email: 'second@example.com', password: 'password123' } };
        const { res, calls } = makeRegisterRes();
        await UserController.register(req, res);
        assert.strictEqual(calls.statusCode, 201);
        assert.strictEqual(createCalls[0].isAdmin, false, 'non-first user must NOT be admin');
    });

    test('DISABLE_REGISTRATION=true env kill switch returns 403 before any create', async () => {
        process.env.DISABLE_REGISTRATION = 'true';
        const req = { body: { email: 'new@example.com', password: 'password123' } };
        const { res, calls } = makeRegisterRes();
        await UserController.register(req, res);
        assert.strictEqual(calls.statusCode, 403);
        assert.deepStrictEqual(calls.body, { error: 'Registration is disabled.' });
        assert.strictEqual(createCalls.length, 0);
    });

    test('runtime settings toggle (disableRegistration) returns 403 before any create', async () => {
        settingsRow = { disableRegistration: true };
        const req = { body: { email: 'new@example.com', password: 'password123' } };
        const { res, calls } = makeRegisterRes();
        await UserController.register(req, res);
        assert.strictEqual(calls.statusCode, 403);
        assert.deepStrictEqual(calls.body, { error: 'Registration is currently disabled.' });
        assert.strictEqual(createCalls.length, 0);
    });

    test('duplicate email returns 409 with the generic message and no create', async () => {
        userFindOneResult = { id: 9 };
        const req = { body: { email: 'taken@example.com', password: 'password123' } };
        const { res, calls } = makeRegisterRes();
        await UserController.register(req, res);
        assert.strictEqual(calls.statusCode, 409);
        assert.deepStrictEqual(calls.body, {
            error: 'Registration failed. Please try a different email.',
        });
        assert.strictEqual(createCalls.length, 0);
    });

    test('validation failure returns 400 with the validator message', async () => {
        validateResult = { error: { message: 'Please provide a valid email.' } };
        const req = { body: { email: 'not-an-email', password: 'password123' } };
        const { res, calls } = makeRegisterRes();
        await UserController.register(req, res);
        assert.strictEqual(calls.statusCode, 400);
        assert.deepStrictEqual(calls.body, { error: 'Please provide a valid email.' });
        assert.strictEqual(createCalls.length, 0);
        assert.strictEqual(findOneCalls.length, 0, 'no dup-check runs when validation fails');
    });
});

// ── middleware/auth.js over the real router ─────────────────────────

describe('middleware/auth.js — unauthenticated API request', { skip: apiRouter ? false : 'routes/api.js could not load' }, () => {
    function withServer(identity, handler) {
        const user = identity === undefined ? { id: 1 } : identity;
        return new Promise((resolve, reject) => {
            const app = express();
            app.use(express.json());
            app.use('/api', (req, res, next) => {
                req.user = user;
                req.isAuthenticated = () => user !== null;
                next();
            });
            app.use('/api', apiRouter);
            app.use((req, res) => res.status(404).json({ error: 'Not found' }));
            const server = app.listen(0, '127.0.0.1', async () => {
                const { port } = server.address();
                try {
                    const out = await handler(`http://127.0.0.1:${port}`);
                    server.close(() => resolve(out));
                } catch (err) {
                    server.close(() => reject(err));
                }
            });
        });
    }

    test('GET /api/sessions without a session responds 401 JSON, not an HTML redirect', async () => {
        const res = await withServer(null, async (base) => fetch(`${base}/api/sessions`));
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(await res.json(), { error: 'Unauthorized' });
    });

    test('the same route is reachable once authenticated', async () => {
        userFindOneResult = makeUser(); // SessionController.getAll checks the user exists
        const res = await withServer({ id: 1 }, async (base) => fetch(`${base}/api/sessions`));
        assert.strictEqual(res.status, 200);
        await res.arrayBuffer();
    });
});
