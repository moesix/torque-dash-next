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

// ── Imports ─────────────────────────────────────────────────────────
const { safeSharedSession } = require('../controllers/SessionController');

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
  });

  it('sets private Cache-Control', async () => {
    const UserController = require('../controllers/UserController');
    const req = {};
    const { res, calls } = makeStubRes();

    await UserController.getSettingsFull(req, res);

    assert.strictEqual(calls.headers['Cache-Control'], 'private, max-age=30');
  });
});

// ── 3. safeSharedSession excludes sensitive fields ──────────────────

describe('safeSharedSession — field projection', () => {
  it('excludes notes, sessionId, vehicleId, vehicleName, userId, updatedAt', () => {
    const session = {
      id: 42,
      name: 'Test Drive',
      startLocation: 'Home',
      endLocation: 'Office',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T01:00:00Z',
      // Fields that should be excluded:
      notes: 'Personal notes here',
      sessionId: 'nanoid_abc123',
      vehicleId: 7,
      vehicleName: 'My Car',
      userId: 99,
    };
    const summary = {
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-01T01:00:00Z',
      maxSpeed: 120,
      maxRpm: 5500,
    };

    const result = safeSharedSession(session, summary);

    // Should include
    assert.strictEqual(result.id, 42);
    assert.strictEqual(result.name, 'Test Drive');
    assert.strictEqual(result.startLocation, 'Home');
    assert.strictEqual(result.endLocation, 'Office');
    assert.strictEqual(result.startDate, '2026-01-01T00:00:00Z');
    assert.strictEqual(result.endDate, '2026-01-01T01:00:00Z');
    assert.strictEqual(result.maxSpeed, 120);
    assert.strictEqual(result.maxRpm, 5500);
    assert.strictEqual(result.createdAt, '2026-01-01T00:00:00Z');

    // Should NOT include
    assert.strictEqual(result.notes, undefined);
    assert.strictEqual(result.sessionId, undefined);
    assert.strictEqual(result.vehicleId, undefined);
    assert.strictEqual(result.vehicleName, undefined);
    assert.strictEqual(result.userId, undefined);
    assert.strictEqual(result.updatedAt, undefined);
  });

  it('returns null for missing summary fields', () => {
    const session = {
      id: 1,
      name: 'Short Trip',
      startLocation: null,
      endLocation: null,
      createdAt: '2026-01-01T00:00:00Z',
    };

    const result = safeSharedSession(session, {});

    assert.strictEqual(result.startDate, null);
    assert.strictEqual(result.endDate, null);
    assert.strictEqual(result.duration, null);
    assert.strictEqual(result.maxSpeed, null);
    assert.strictEqual(result.maxRpm, null);
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
