'use strict';

// Plan 110: behavioral coverage for TelemetryController.range over the real
// router (routes/api.js) — ownership scoping, ?shareId shared access, the
// 400/404/401 contract and the limit clamp. Mirrors the analysisJournal
// HTTP-level harness: real router, mocked models via require.cache.

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';
// The deploy-time kill switches are not under test here.
delete process.env.DISABLE_REGISTRATION;
delete process.env.UPLOAD_API_TOKEN;

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// ── Pre-populate require.cache for ../models ────────────────────────

// Op.between is the only operator TelemetryController.range uses; exposing it
// from the mocked models keeps assertions against the same symbol object the
// controller destructured at load time.
const Op = { between: Symbol('between') };

const mockModels = {
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
    User: {
        findOne: async () => null,
        findAll: async () => [],
    },
    Settings: {
        getSingleton: async () => ({ disableRegistration: false }),
    },
    sequelize: {
        query: async () => [],
        QueryTypes: { SELECT: 'SELECT' },
        fn: () => {},
        col: () => {},
    },
    Sequelize: { Op },
};

const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
    id: modelsPath,
    filename: modelsPath,
    loaded: true,
    exports: mockModels,
};

// Mock heavy LLM-analysis dependencies so requiring controllers that import
// them (AnalysisController) stays side-effect free (same as analysisJournal).
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

// Load the real router under the same require.cache mocks.
let apiRouter;
try {
    apiRouter = require('../routes/api');
} catch (err) {
    console.error('[telemetryAccess.test] routes/api.js failed to load:', err.message);
    apiRouter = null;
}

// ── Helpers ─────────────────────────────────────────────────────────

// Per-test DB behavior. Returns recorders for the calls the controller made.
function installDbMocks({ userByShareId = null, ownedSession = null, logRows = [] } = {}) {
    const calls = { userFindOne: [], sessionFindOne: [], logFindAll: [] };
    mockModels.User.findOne = async (opts) => {
        calls.userFindOne.push(opts);
        return userByShareId;
    };
    mockModels.Session.findOne = async (opts) => {
        calls.sessionFindOne.push(opts);
        return ownedSession;
    };
    mockModels.Log.findAll = async (opts) => {
        calls.logFindAll.push(opts);
        return logRows;
    };
    return calls;
}

function resetDbMocks() {
    mockModels.User.findOne = async () => null;
    mockModels.Session.findOne = async () => null;
    mockModels.Log.findAll = async () => [];
}

// Boot the real router on an ephemeral port. `identity` becomes req.user for
// the whole request (null = unauthenticated). isAuthenticated() mirrors it, so
// the real authenticate middleware lets authenticated identities through.
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

async function getJson(base, path) {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: await res.json() };
}

const TELEMETRY_PATH = (qs) => `/api/sessions/7/telemetry${qs ? `?${qs}` : ''}`;
const FROM = '2026-08-25T00:00:00.000Z';
const TO = '2026-08-25T23:59:59.999Z';
const qsFromTo = () => `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
const OWNED_SESSION = { id: 7 };

beforeEach(() => {
    resetDbMocks();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('GET /api/sessions/:id/telemetry — TelemetryController.range', { skip: apiRouter ? false : 'routes/api.js could not load' }, () => {
    test('missing from or to returns 400 before any DB access', async () => {
        for (const qs of ['', 'from=2026-08-25T00:00:00.000Z', 'to=2026-08-25T00:00:00.000Z']) {
            const calls = installDbMocks();
            const { status, body } = await withServer({ id: 1 }, (base) => getJson(base, TELEMETRY_PATH(qs)));

            assert.strictEqual(status, 400, `qs=${qs}`);
            assert.deepStrictEqual(body, { error: 'from and to are required' });
            assert.strictEqual(calls.userFindOne.length, 0, 'no user lookup on missing params');
            assert.strictEqual(calls.sessionFindOne.length, 0, 'no session lookup on missing params');
            assert.strictEqual(calls.logFindAll.length, 0, 'no log query on missing params');
        }
    });

    test('owner match returns 200 with rows and a between-scoped Log query', async () => {
        const rows = [
            { id: 1, timestamp: FROM, lon: 1.5, lat: 2.5, values: {}, engine_rpm: 2500, vehicle_speed: 60 },
            { id: 2, timestamp: TO, lon: 1.6, lat: 2.6, values: {}, engine_rpm: 0, vehicle_speed: 0 },
        ];
        const calls = installDbMocks({ ownedSession: OWNED_SESSION, logRows: rows });

        const { status, body } = await withServer({ id: 1 }, (base) =>
            getJson(base, TELEMETRY_PATH(qsFromTo()))
        );

        assert.strictEqual(status, 200);
        assert.strictEqual(body.length, 2);
        assert.strictEqual(body[0].id, 1);
        assert.strictEqual(body[1].engine_rpm, 0);
        // Ownership scoping reaches Session.findOne: the user's own id, plus the
        // route param id.
        assert.deepStrictEqual(calls.sessionFindOne[0].where, { userId: 1, id: '7' });
        // Log.findAll is scoped to the resolved session and the [from,to] window.
        const logOpts = calls.logFindAll[0];
        assert.strictEqual(logOpts.where.sessionId, 7);
        assert.deepStrictEqual(logOpts.where.timestamp[Op.between], [new Date(FROM), new Date(TO)]);
        assert.deepStrictEqual(logOpts.order, [['timestamp', 'ASC']]);
    });

    test('clamps a huge requested limit down to 10000', async () => {
        const calls = installDbMocks({ ownedSession: OWNED_SESSION });

        const { status } = await withServer({ id: 1 }, (base) =>
            getJson(base, TELEMETRY_PATH(`${qsFromTo()}&limit=999999`))
        );

        assert.strictEqual(status, 200);
        assert.strictEqual(calls.logFindAll[0].limit, 10000, 'limit must clamp at 10000');
    });

    test('defaults the limit to 5000 when no limit is given', async () => {
        const calls = installDbMocks({ ownedSession: OWNED_SESSION });

        const { status } = await withServer({ id: 1 }, (base) =>
            getJson(base, TELEMETRY_PATH(qsFromTo()))
        );

        assert.strictEqual(status, 200);
        assert.strictEqual(calls.logFindAll[0].limit, 5000, 'absent limit must default to 5000');
    });

    test('wrong owner (no session row for this user) returns 404', async () => {
        // User 1 asks for session 7 which belongs to someone else — the scoped
        // Session.findOne finds nothing.
        const calls = installDbMocks({ ownedSession: null });

        const { status, body } = await withServer({ id: 1 }, (base) =>
            getJson(base, TELEMETRY_PATH(qsFromTo()))
        );

        assert.strictEqual(status, 404);
        assert.deepStrictEqual(body, { error: 'Not found' });
        assert.deepStrictEqual(calls.sessionFindOne[0].where, { userId: 1, id: '7' });
        assert.strictEqual(calls.logFindAll.length, 0, 'no log query on ownership miss');
    });

    test('?shareId resolves the session under the SHARED user, not the caller', async () => {
        // Caller is user 1; the shareId maps to user 2 who owns session 7.
        const calls = installDbMocks({
            userByShareId: { id: 2 },
            ownedSession: { id: 7 },
            logRows: [{ id: 9, timestamp: FROM }],
        });

        const { status, body } = await withServer({ id: 1 }, (base) =>
            getJson(base, TELEMETRY_PATH(`${qsFromTo()}&shareId=shared-public-id`))
        );

        assert.strictEqual(status, 200);
        assert.strictEqual(body.length, 1);
        // The session lookup must be scoped to the SHARE OWNER (2), never the caller.
        assert.deepStrictEqual(calls.userFindOne[0], { where: { shareId: 'shared-public-id' } });
        assert.deepStrictEqual(calls.sessionFindOne[0].where, { userId: 2, id: '7' });
        assert.strictEqual(calls.logFindAll[0].where.sessionId, 7);
    });

    test('?shareId for an unknown share owner returns 404 without a session lookup', async () => {
        const calls = installDbMocks({ userByShareId: null });

        const { status, body } = await withServer({ id: 1 }, (base) =>
            getJson(base, TELEMETRY_PATH(`${qsFromTo()}&shareId=nope`))
        );

        assert.strictEqual(status, 404);
        assert.deepStrictEqual(body, { error: 'Not found' });
        assert.strictEqual(calls.sessionFindOne.length, 0, 'session must not be queried when the share owner is unknown');
        assert.strictEqual(calls.logFindAll.length, 0);
    });

    test('unauthenticated non-shareId request returns 401 JSON', async () => {
        await withServer(null, async (base) => {
            const { status, body } = await getJson(base, TELEMETRY_PATH(qsFromTo()));
            assert.strictEqual(status, 401);
            assert.deepStrictEqual(body, { error: 'Unauthorized' });
        });
    });
});
