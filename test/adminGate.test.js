'use strict';

// Plan 099: first registered user is the admin — HTTP-level coverage.
//
// Follows the test/analysisJournal.test.js harness pattern: the REAL router
// (routes/api.js) mounted on an express app, with ../models pre-populated in
// require.cache as mocks, so route registration AND the controller gates are
// exercised end-to-end. The withServer identity is parameterized so admin and
// non-admin sessions can be simulated per test.

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';
// The deploy-time registration kill switch and env-sourced upload token are
// NOT under test here — remove them so the runtime toggle / DB token paths
// (which these tests exercise) are reachable.
delete process.env.DISABLE_REGISTRATION;
delete process.env.UPLOAD_API_TOKEN;

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// ── Pre-populate require.cache for ../models ────────────────────────

let settingsRow;
const upsertCalls = [];
const saveCalls = [];
const createCalls = [];

function makeSettingsRow() {
    const row = {
        id: 1,
        disableRegistration: false,
        uploadApiToken: null,
        llmProvider: null,
        llmModel: null,
        llmEndpoint: null,
        llmApiKeyEnc: null,
        vehicleMake: null,
        vehicleModel: null,
        vehicleYear: null,
        engineCc: null,
        llmThinkingMode: true,
        llmReasoningEffort: 'high',
        llmMaxTokens: 16384,
        timezoneOffset: 0,
        retentionEnabled: false,
        retentionDays: 365,
    };
    // generateUploadToken mutates the singleton instance then calls save() on
    // it — mirror the real Sequelize instance surface.
    row.save = async () => {
        saveCalls.push(row);
        return row;
    };
    return row;
}

const mockModels = {
    User: {
        count: async () => 0,
        findOne: async () => null,
        create: async (attrs) => {
            createCalls.push(attrs);
            return { id: 1, ...attrs };
        },
        validate: () => ({ error: null }),
    },
    Settings: {
        getSingleton: async () => settingsRow,
        invalidateCache: () => {},
        upsert: async (data) => {
            upsertCalls.push(data);
            Object.assign(settingsRow, data);
            return settingsRow;
        },
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
    console.error('[adminGate.test] routes/api.js failed to load:', err.message);
    apiRouter = null;
}

beforeEach(() => {
    settingsRow = makeSettingsRow();
    upsertCalls.length = 0;
    saveCalls.length = 0;
    createCalls.length = 0;
    mockModels.User.count = async () => 0;
    mockModels.User.findOne = async () => null;
});

// ── Helpers ─────────────────────────────────────────────────────────

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

async function sendJson(base, path, method, body) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed = null;
    try {
        parsed = await res.json();
    } catch {
        // non-JSON body — leave null
    }
    return { status: res.status, body: parsed };
}

const ADMIN = { id: 1, isAdmin: true };
const NON_ADMIN = { id: 2 }; // authenticated, but not the first-registered user

// ── Tests ───────────────────────────────────────────────────────────

describe('POST /api/users/register — first-user admin bootstrap', { skip: apiRouter ? false : 'routes/api.js could not load' }, () => {
    test('first registered user is persisted with isAdmin: true', async () => {
        mockModels.User.count = async () => 0;

        const { status, body } = await withServer(null, (base) =>
            sendJson(base, '/api/users/register', 'POST', { email: 'first@example.com', password: 'password123' })
        );

        assert.strictEqual(status, 201);
        assert.deepStrictEqual(body, { ok: true });
        assert.strictEqual(createCalls.length, 1, 'exactly one User.create');
        assert.strictEqual(createCalls[0].email, 'first@example.com');
        assert.strictEqual(createCalls[0].isAdmin, true, 'first user must be admin');
    });

    test('second registered user is persisted with isAdmin: false', async () => {
        mockModels.User.count = async () => 1;

        const { status } = await withServer(null, (base) =>
            sendJson(base, '/api/users/register', 'POST', { email: 'second@example.com', password: 'password123' })
        );

        assert.strictEqual(status, 201);
        assert.strictEqual(createCalls.length, 1);
        assert.strictEqual(createCalls[0].email, 'second@example.com');
        assert.strictEqual(createCalls[0].isAdmin, false, 'non-first user must NOT be admin');
    });
});

describe('PUT /api/settings — admin-only gate', { skip: apiRouter ? false : 'routes/api.js could not load' }, () => {
    test('non-admin PUT returns 403 and does not update the settings row', async () => {
        const { status, body } = await withServer(NON_ADMIN, (base) =>
            sendJson(base, '/api/settings', 'PUT', { disableRegistration: true })
        );

        assert.strictEqual(status, 403);
        assert.deepStrictEqual(body, { error: 'Admin access required.' });
        assert.strictEqual(upsertCalls.length, 0, 'settings must not be written for a non-admin');
        assert.strictEqual(settingsRow.disableRegistration, false);
    });

    test('admin PUT returns 200 and updates the settings row with the payload', async () => {
        const { status, body } = await withServer(ADMIN, (base) =>
            sendJson(base, '/api/settings', 'PUT', { timezoneOffset: 300 })
        );

        assert.strictEqual(status, 200);
        assert.strictEqual(body.timezoneOffset, 300);
        assert.strictEqual(upsertCalls.length, 1);
        assert.deepStrictEqual(upsertCalls[0], { id: 1, timezoneOffset: 300 });
    });
});

describe('POST /api/settings/upload-token — admin-only gate', { skip: apiRouter ? false : 'routes/api.js could not load' }, () => {
    test('non-admin POST returns 403 and never rotates the token', async () => {
        const { status, body } = await withServer(NON_ADMIN, (base) =>
            sendJson(base, '/api/settings/upload-token', 'POST')
        );

        assert.strictEqual(status, 403);
        assert.deepStrictEqual(body, { error: 'Admin access required.' });
        assert.strictEqual(saveCalls.length, 0, 'token row must not be saved for a non-admin');
        assert.strictEqual(settingsRow.uploadApiToken, null);
    });

    test('admin POST returns 200 with a fresh 64-hex token', async () => {
        const { status, body } = await withServer(ADMIN, (base) =>
            sendJson(base, '/api/settings/upload-token', 'POST')
        );

        assert.strictEqual(status, 200);
        assert.match(body.uploadApiToken, /^[0-9a-f]{64}$/);
        assert.strictEqual(saveCalls.length, 1);
        assert.strictEqual(settingsRow.uploadApiToken, body.uploadApiToken);
    });
});

describe('GET /api/settings — public shape and session-derived isAdmin', { skip: apiRouter ? false : 'routes/api.js could not load' }, () => {
    test('unauthenticated response keeps the exact two-field public shape (no crash without req.user)', async () => {
        const { status, body } = await withServer(null, (base) => getJson(base, '/api/settings'));

        assert.strictEqual(status, 200);
        assert.deepStrictEqual(
            Object.keys(body).sort(),
            ['disableRegistration', 'tokenFromEnv'],
            'anonymous /api/settings must stay { disableRegistration, tokenFromEnv }'
        );
        assert.strictEqual(typeof body.disableRegistration, 'boolean');
        assert.strictEqual(body.isAdmin, undefined);
    });

    test('authenticated non-admin sees isAdmin: false', async () => {
        const { status, body } = await withServer(NON_ADMIN, (base) => getJson(base, '/api/settings'));

        assert.strictEqual(status, 200);
        assert.strictEqual(body.isAdmin, false);
        assert.strictEqual(typeof body.disableRegistration, 'boolean');
    });

    test('authenticated admin sees isAdmin: true (derived from the session, not client input)', async () => {
        const { status, body } = await withServer(ADMIN, (base) => getJson(base, '/api/settings'));

        assert.strictEqual(status, 200);
        assert.strictEqual(body.isAdmin, true);
    });
});

describe('GET /api/settings/full — authenticated projection carries isAdmin', { skip: apiRouter ? false : 'routes/api.js could not load' }, () => {
    test('admin full-settings response includes isAdmin: true alongside the settings fields', async () => {
        const { status, body } = await withServer(ADMIN, (base) => getJson(base, '/api/settings/full'));

        assert.strictEqual(status, 200);
        assert.strictEqual(body.isAdmin, true);
        assert.ok(Object.prototype.hasOwnProperty.call(body, 'llmProvider'), 'full settings shape must be intact');
        assert.strictEqual(typeof body.retentionEnabled, 'boolean');
    });

    test('non-admin full-settings response includes isAdmin: false', async () => {
        const { status, body } = await withServer(NON_ADMIN, (base) => getJson(base, '/api/settings/full'));

        assert.strictEqual(status, 200);
        assert.strictEqual(body.isAdmin, false);
    });
});
