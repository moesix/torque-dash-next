'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// ── Pre-populate require.cache for ../models ────────────────────────
const mockModels = {
  Session: {
    findOne: async () => null,
    findAll: async () => [],
    count: async () => 0,
    update: async () => [0],
    create: async () => ({}),
    destroy: async () => 0,
  },
  Log: {
    count: async () => 0,
    findAll: async () => [],
    destroy: async () => 0,
  },
  User: { findOne: async () => null, validate: () => ({ error: null }) },
  Vehicle: { findOne: async () => null },
  Settings: {
    getSingleton: async () => ({
      disableRegistration: false,
      uploadApiToken: 'tok_abc',
      llmProvider: 'openai',
      llmModel: 'gpt-4o',
      llmEndpoint: 'http://192.168.1.100:11434',
      llmApiKeyEnc: 'enc_abc',
      vehicleMake: 'Toyota',
      vehicleModel: 'Corolla',
      vehicleYear: 2020,
      engineCc: 1800,
      llmThinkingMode: true,
      llmReasoningEffort: 'high',
      llmMaxTokens: 16384,
      timezoneOffset: 480,
      retentionEnabled: false,
      retentionDays: 365,
      tileProvider: 'osm',
      cartoApiKey: null,
    }),
    invalidateCache: () => {},
    upsert: async () => {},
  },
  sequelize: {
    transaction: async (fn) => fn({}),
    query: async () => [],
    fn: () => {},
    col: () => {},
  },
  Sequelize: { Op: {} },
};

const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath,
  filename: modelsPath,
  loaded: true,
  exports: mockModels,
};

// ── Mock heavy LLM-analysis dependencies so requiring routes/api.js
// (which pulls in AnalysisController) stays side-effect free.
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
  exports: {
    buildAnalysisPrompt: () => 'test prompt',
    formatSessionDuration: () => '',
    detectBackfillGaps: () => [],
    buildDataQualityNote: () => '',
  },
};
const pidRegistryPath = require.resolve('../lib/pidRegistry');
require.cache[pidRegistryPath] = {
  id: pidRegistryPath,
  filename: pidRegistryPath,
  loaded: true,
  exports: { discoverPidKeys: async () => ({}) },
};

// ── Helpers ─────────────────────────────────────────────────────────
function makeStubRes() {
  const calls = { statusCode: null, body: null, headers: {} };
  const res = {
    status(code) { calls.statusCode = code; return res; },
    json(obj) { calls.body = obj; return res; },
    sendStatus(code) { calls.statusCode = code; return res; },
    set(key, val) { calls.headers[key] = val; return res; },
    send(data) { calls.body = data; return res; },
  };
  return { res, calls };
}

// ── 1. getSettings returns only disableRegistration + tokenFromEnv ───

describe('GET /api/settings — public endpoint trimmed', () => {
  it('returns only disableRegistration and tokenFromEnv', async () => {
    const UserController = require('../controllers/UserController');
    const req = {};
    const { res, calls } = makeStubRes();

    await UserController.getSettings(req, res);

    const keys = Object.keys(calls.body);
    assert.deepStrictEqual(keys.sort(), ['disableRegistration', 'tokenFromEnv'],
      `Expected exactly [disableRegistration, tokenFromEnv] but got: ${keys.join(', ')}`);
    assert.strictEqual(typeof calls.body.disableRegistration, 'boolean');
    assert.strictEqual(typeof calls.body.tokenFromEnv, 'boolean');
  });

  it('does NOT expose llmEndpoint, vehicleMake, or hasLlmApiKey', async () => {
    const UserController = require('../controllers/UserController');
    const req = {};
    const { res, calls } = makeStubRes();

    await UserController.getSettings(req, res);

    assert.strictEqual(calls.body.llmEndpoint, undefined);
    assert.strictEqual(calls.body.vehicleMake, undefined);
    assert.strictEqual(calls.body.hasLlmApiKey, undefined);
    assert.strictEqual(calls.body.hasUploadApiToken, undefined);
    assert.strictEqual(calls.body.llmProvider, undefined);
  });

  it('sets Cache-Control header', async () => {
    const UserController = require('../controllers/UserController');
    const req = {};
    const { res, calls } = makeStubRes();

    await UserController.getSettings(req, res);

    assert.strictEqual(calls.headers['Cache-Control'], 'public, max-age=30');
  });
});

// ── 2. getSettingsFull returns all fields ───────────────────────────

describe('GET /api/settings/full — authenticated full settings', () => {
  it('returns all expected fields', async () => {
    const UserController = require('../controllers/UserController');
    const req = {};
    const { res, calls } = makeStubRes();

    await UserController.getSettingsFull(req, res);

    const keys = Object.keys(calls.body);
    assert.ok(keys.includes('disableRegistration'));
    assert.ok(keys.includes('tokenFromEnv'));
    assert.ok(keys.includes('hasUploadApiToken'));
    assert.ok(keys.includes('hasLlmProvider'));
    assert.ok(keys.includes('llmProvider'));
    assert.ok(keys.includes('llmModel'));
    assert.ok(keys.includes('llmEndpoint'));
    assert.ok(keys.includes('hasLlmApiKey'));
    assert.ok(keys.includes('vehicleMake'));
    assert.ok(keys.includes('vehicleModel'));
    assert.ok(keys.includes('vehicleYear'));
    assert.ok(keys.includes('engineCc'));
    assert.ok(keys.includes('llmThinkingMode'));
    assert.ok(keys.includes('llmReasoningEffort'));
    assert.ok(keys.includes('llmMaxTokens'));
    assert.ok(keys.includes('timezoneOffset'));
    assert.ok(keys.includes('retentionEnabled'));
    assert.ok(keys.includes('retentionDays'));
    // Map basemap (migration 021): the provider is always surfaced; the CARTO
    // key is NOT — the mocked row has tileProvider 'osm'.
    assert.ok(keys.includes('tileProvider'));
    assert.strictEqual(calls.body.tileProvider, 'osm');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(calls.body, 'cartoApiKey'),
      false,
      'cartoApiKey must be omitted while OSM is the active provider'
    );
  });

  it('surfaces the stored cartoApiKey ONLY when carto is the active provider', async () => {
    const UserController = require('../controllers/UserController');
    const originalGetSingleton = mockModels.Settings.getSingleton;
    mockModels.Settings.getSingleton = async () => ({
      disableRegistration: false,
      uploadApiToken: null,
      tileProvider: 'carto',
      cartoApiKey: 'carto_live_key',
    });

    try {
      const { res, calls } = makeStubRes();

      await UserController.getSettingsFull({}, res);

      assert.strictEqual(calls.body.tileProvider, 'carto');
      assert.strictEqual(calls.body.cartoApiKey, 'carto_live_key');
    } finally {
      mockModels.Settings.getSingleton = originalGetSingleton;
    }
  });

  it('keeps carto selected with an empty key (frontend declines to render)', async () => {
    const UserController = require('../controllers/UserController');
    const originalGetSingleton = mockModels.Settings.getSingleton;
    mockModels.Settings.getSingleton = async () => ({
      tileProvider: 'carto',
      cartoApiKey: '',
    });

    try {
      const { res, calls } = makeStubRes();

      await UserController.getSettingsFull({}, res);

      assert.strictEqual(calls.body.tileProvider, 'carto');
      assert.strictEqual(calls.body.cartoApiKey, '');
    } finally {
      mockModels.Settings.getSingleton = originalGetSingleton;
    }
  });

  it('sets private Cache-Control', async () => {
    const UserController = require('../controllers/UserController');
    const req = {};
    const { res, calls } = makeStubRes();

    await UserController.getSettingsFull(req, res);

    assert.strictEqual(calls.headers['Cache-Control'], 'private, max-age=30');
  });
});

// ── 4. Registration returns generic message on duplicate email ──────

describe('POST /api/users/register — enumeration prevention', () => {
  it('returns generic message for duplicate email', async () => {
    // Override User.findOne to simulate an existing user
    const originalFindOne = mockModels.User.findOne;
    mockModels.User.findOne = async () => ({ id: 1, email: 'test@example.com' });

    try {
      const UserController = require('../controllers/UserController');
      const req = {
        body: { email: 'test@example.com', password: 'password123' },
      };
      const { res, calls } = makeStubRes();

      await UserController.register(req, res);

    assert.strictEqual(calls.statusCode, 409);
    assert.strictEqual(calls.body.error, 'Registration failed. Please try a different email.');
    // Ensure the response does NOT reveal whether the email exists
    assert.ok(!calls.body.error.includes('already registered'));
    assert.ok(!calls.body.error.includes('already'));
  } finally {
      mockModels.User.findOne = originalFindOne;
    }
  });
});

// ── 5. Share-link surface removed — its routes are gone ──────────────

// Boot the real api router on an ephemeral port with the models above, then
// let unmatched requests fall through to the same JSON 404 the app installs.
function withApiServer(handler) {
  const express = require('express');
  const apiRouter = require('../routes/api');
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
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

describe('removed share-link endpoints — route-gone regression', () => {
  it('GET /api/sessions/shared/<anything> returns the app-level JSON 404', async () => {
    const res = await withApiServer((base) =>
      fetch(`${base}/api/sessions/shared/anything`));

    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'Not found' });
  });

  it('PATCH /api/users/shareid returns the app-level JSON 404', async () => {
    const res = await withApiServer((base) =>
      fetch(`${base}/api/users/shareid`, { method: 'PATCH' }));

    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'Not found' });
  });
});

// ── 6. updateSettings validates llmProvider/llmModel before persisting ──────

describe('PUT /api/settings — updateSettings llmProvider/llmModel validation (admin write path)', () => {
  const adminReq = (body) => ({ user: { id: 1, isAdmin: true }, body });

  function captureUpsert() {
    const captured = [];
    const originalUpsert = mockModels.Settings.upsert;
    mockModels.Settings.upsert = async (data) => { captured.push(data); };
    return { captured, restore: () => { mockModels.Settings.upsert = originalUpsert; } };
  }

  it('rejects an unknown llmProvider with 400 and does NOT persist', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ llmProvider: 'not-a-provider' }), res);

      assert.strictEqual(calls.statusCode, 400);
      assert.ok(calls.body.error.includes('llmProvider'),
        `error should name llmProvider: ${JSON.stringify(calls.body)}`);
      assert.strictEqual(captured.length, 0, 'invalid provider must not reach Settings.upsert');
    } finally {
      restore();
    }
  });

  it('accepts an allowlisted llmProvider and persists it', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ llmProvider: 'deepseek' }), res);

      // 200 path resolves via res.json() (no explicit status) — assert the
      // write reached the DB and a JSON body was produced.
      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured.length, 1);
      assert.strictEqual(captured[0].llmProvider, 'deepseek');
    } finally {
      restore();
    }
  });

  it('accepts llmProvider null (clearing the provider) and persists it', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ llmProvider: null }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured[0].llmProvider, null);
    } finally {
      restore();
    }
  });

  it('rejects an llmModel longer than 200 chars with 400 and does NOT persist', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ llmModel: 'm'.repeat(201) }), res);

      assert.strictEqual(calls.statusCode, 400);
      assert.ok(calls.body.error.includes('llmModel'),
        `error should name llmModel: ${JSON.stringify(calls.body)}`);
      assert.strictEqual(captured.length, 0, 'oversized model must not reach Settings.upsert');
    } finally {
      restore();
    }
  });

  it('rejects a non-string llmModel with 400 and does NOT persist', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ llmModel: 123 }), res);

      assert.strictEqual(calls.statusCode, 400);
      assert.strictEqual(captured.length, 0);
    } finally {
      restore();
    }
  });

  it('accepts a 200-char llmModel and persists it (boundary)', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ llmModel: 'm'.repeat(200) }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured[0].llmModel.length, 200);
    } finally {
      restore();
    }
  });

  it('admin gate fires before provider validation (403 for non-admin, not 400)', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const req = { user: { id: 1, isAdmin: false }, body: { llmProvider: 'not-a-provider' } };
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(req, res);

      assert.strictEqual(calls.statusCode, 403);
      assert.strictEqual(captured.length, 0);
    } finally {
      restore();
    }
  });
});

// ── 7. updateSettings validates analysisRetentionDays (admin write path) ────

describe('PUT /api/settings — updateSettings analysisRetentionDays validation (admin write path)', () => {
  const adminReq = (body) => ({ user: { id: 1, isAdmin: true }, body });

  function captureUpsert() {
    const captured = [];
    const originalUpsert = mockModels.Settings.upsert;
    mockModels.Settings.upsert = async (data) => { captured.push(data); };
    return { captured, restore: () => { mockModels.Settings.upsert = originalUpsert; } };
  }

  it('persists a valid analysisRetentionDays (180)', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ analysisRetentionDays: 180 }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured.length, 1);
      assert.strictEqual(captured[0].analysisRetentionDays, 180);
    } finally {
      restore();
    }
  });

  it('rejects an out-of-range analysisRetentionDays (7) with 400 and does NOT persist', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ analysisRetentionDays: 7 }), res);

      assert.strictEqual(calls.statusCode, 400);
      assert.ok(calls.body.error.includes('analysisRetentionDays'),
        `error should name analysisRetentionDays: ${JSON.stringify(calls.body)}`);
      assert.strictEqual(captured.length, 0, 'invalid days must not reach Settings.upsert');
    } finally {
      restore();
    }
  });

  it('rejects a non-integer analysisRetentionDays with 400', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ analysisRetentionDays: 'abc' }), res);

      assert.strictEqual(calls.statusCode, 400);
      assert.strictEqual(captured.length, 0);
    } finally {
      restore();
    }
  });

  it('accepts null (clearing/disabling the prune job) and persists null', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ analysisRetentionDays: null }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured.length, 1);
      assert.strictEqual(captured[0].analysisRetentionDays, null);
    } finally {
      restore();
    }
  });

  it('rejects analysisRetentionDays above 365', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ analysisRetentionDays: 366 }), res);

      assert.strictEqual(calls.statusCode, 400);
      assert.ok(calls.body.error.includes('between 90 and 365'));
      assert.strictEqual(captured.length, 0);
    } finally {
      restore();
    }
  });
});

// ── 8. updateSettings validates map tile settings (admin write path) ────────

// Migration 021: 'osm' is the default keyless basemap provider; 'carto' is the
// opt-in upgrade requiring the admin's CARTO API key.
describe('PUT /api/settings — updateSettings tileProvider/cartoApiKey validation (admin write path)', () => {
  const adminReq = (body) => ({ user: { id: 1, isAdmin: true }, body });

  function captureUpsert() {
    const captured = [];
    const originalUpsert = mockModels.Settings.upsert;
    mockModels.Settings.upsert = async (data) => { captured.push(data); };
    return { captured, restore: () => { mockModels.Settings.upsert = originalUpsert; } };
  }

  it('persists a valid tileProvider ("osm")', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ tileProvider: 'osm' }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured.length, 1);
      assert.strictEqual(captured[0].tileProvider, 'osm');
    } finally {
      restore();
    }
  });

  it('persists the opt-in "carto" provider', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ tileProvider: 'carto', cartoApiKey: 'k1' }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured[0].tileProvider, 'carto');
      assert.strictEqual(captured[0].cartoApiKey, 'k1');
    } finally {
      restore();
    }
  });

  it('rejects an unknown tileProvider with 400 and does NOT persist', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ tileProvider: 'carto-dark' }), res);

      assert.strictEqual(calls.statusCode, 400);
      assert.ok(calls.body.error.includes('tileProvider'),
        `error should name tileProvider: ${JSON.stringify(calls.body)}`);
      assert.strictEqual(captured.length, 0, 'invalid provider must not reach Settings.upsert');
    } finally {
      restore();
    }
  });

  it('rejects a cartoApiKey longer than 255 chars with 400 and does NOT persist', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ cartoApiKey: 'k'.repeat(256) }), res);

      assert.strictEqual(calls.statusCode, 400);
      assert.ok(calls.body.error.includes('cartoApiKey'),
        `error should name cartoApiKey: ${JSON.stringify(calls.body)}`);
      assert.strictEqual(captured.length, 0, 'oversized key must not reach Settings.upsert');
    } finally {
      restore();
    }
  });

  it('normalizes a whitespace-only cartoApiKey to the empty string', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ cartoApiKey: '   ' }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured[0].cartoApiKey, '');
    } finally {
      restore();
    }
  });

  it('stores the trimmed cartoApiKey (not the raw padded input)', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ cartoApiKey: ' key ' }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured[0].cartoApiKey, 'key');
    } finally {
      restore();
    }
  });

  it('accepts an explicit empty cartoApiKey (frontend declines to render CARTO without a key)', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ tileProvider: 'carto', cartoApiKey: '' }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured[0].tileProvider, 'carto');
      assert.strictEqual(captured[0].cartoApiKey, '');
    } finally {
      restore();
    }
  });

  it('rejects a null cartoApiKey with 400 (clearing is the empty string, not null)', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ cartoApiKey: null }), res);

      assert.strictEqual(calls.statusCode, 400);
      assert.strictEqual(captured.length, 0);
    } finally {
      restore();
    }
  });

  it('touches neither map field when absent (partial PUTs keep the exact prior shape)', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(adminReq({ timezoneOffset: -60 }), res);

      assert.ok(calls.body, 'expected a JSON settings body on success');
      assert.strictEqual(captured.length, 1);
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(captured[0], 'tileProvider'),
        false
      );
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(captured[0], 'cartoApiKey'),
        false
      );
    } finally {
      restore();
    }
  });

  it('admin gate fires before map-field validation (403 for non-admin, not 400)', async () => {
    const UserController = require('../controllers/UserController');
    const { captured, restore } = captureUpsert();
    try {
      const req = { user: { id: 1, isAdmin: false }, body: { tileProvider: 'not-a-provider' } };
      const { res, calls } = makeStubRes();
      await UserController.updateSettings(req, res);

      assert.strictEqual(calls.statusCode, 403);
      assert.strictEqual(captured.length, 0);
    } finally {
      restore();
    }
  });
});
