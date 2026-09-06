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
const SessionController = require('../controllers/SessionController');
const { safeSharedSession } = SessionController;

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

// ── 5. Shared endpoints project safe fields through the controller ──

// A session row carrying every field a share link must never leak.
function makeSensitiveSession(overrides = {}) {
  return {
    id: 42,
    sessionId: 'nanoid_secret_abc',
    name: 'Weekend Trip',
    notes: 'private annotation — must never be published',
    vehicleId: 7,
    vehicleName: 'My Car',
    userId: 99,
    createdAt: '2026-02-02T10:00:00Z',
    updatedAt: '2026-02-02T11:00:00Z',
    ...overrides,
  };
}

describe('getOneShared — safe projection through the controller', () => {
  it('response body contains NO notes/sessionId/vehicleId/vehicleName', async () => {
    const originalUserFindOne = mockModels.User.findOne;
    const originalSessionFindOne = mockModels.Session.findOne;
    mockModels.User.findOne = async () => ({ id: 99, shareId: 'share_abc' });
    mockModels.Session.findOne = async () =>
      makeSensitiveSession({ id: 42 });

    try {
      const req = { params: { shareId: 'share_abc', sessionId: '42' }, query: {} };
      const { res, calls } = makeStubRes();

      await SessionController.getOneShared(req, res);

      assert.ok(calls.body, 'expected a JSON body (200 path)');
      for (const forbidden of ['notes', 'sessionId', 'vehicleId', 'vehicleName']) {
        assert.strictEqual(calls.body[forbidden], undefined,
          `shared response leaked "${forbidden}"`);
      }
      // Safe fields still present
      assert.strictEqual(calls.body.id, 42);
      assert.strictEqual(calls.body.name, 'Weekend Trip');
      assert.strictEqual(calls.body.startDate, null); // empty summary → null, not missing
    } finally {
      mockModels.User.findOne = originalUserFindOne;
      mockModels.Session.findOne = originalSessionFindOne;
    }
  });
});

describe('getAllShared — pagination envelope and projection', () => {
  // findAll is called by BOTH the handler (page fetch) and the internal
  // aggregateSummaries helper (denormalized-column lookup). Distinguish them:
  // the handler's call carries `limit`; aggregateSummaries carries `attributes`.
  function installFindAllCapture(fakeSessions) {
    const allCalls = [];
    const original = mockModels.Session.findAll;
    mockModels.Session.findAll = async (opts) => {
      allCalls.push(opts);
      if (opts && opts.attributes) return []; // aggregate lookup → no denormalized rows
      return fakeSessions;
    };
    return { allCalls, restore: () => { mockModels.Session.findAll = original; } };
  }

  it('passes limit/offset/order to findAll and returns the {sessions,total,limit,offset} envelope', async () => {
    const originalUserFindOne = mockModels.User.findOne;
    const originalSessionCount = mockModels.Session.count;
    mockModels.User.findOne = async () => ({ id: 99, shareId: 'share_abc' });
    mockModels.Session.count = async () => 42; // total ≫ page size
    const fakeSessions = [
      makeSensitiveSession({ id: 1, name: 'Trip 1' }),
      makeSensitiveSession({ id: 2, name: 'Trip 2' }),
      makeSensitiveSession({ id: 3, name: 'Trip 3' }),
    ];
    const { allCalls, restore } = installFindAllCapture(fakeSessions);

    try {
      const req = { params: { shareId: 'share_abc' }, query: {} }; // no params → defaults
      const { res, calls } = makeStubRes();

      await SessionController.getAllShared(req, res);

      // findAll captured options include default limit/offset + DESC order
      const handlerCalls = allCalls.filter(o => o && o.limit !== undefined);
      assert.strictEqual(handlerCalls.length, 1, 'handler should issue exactly one page-fetch findAll');
      const opts = handlerCalls[0];
      assert.strictEqual(opts.limit, 50, 'default limit must be 50');
      assert.strictEqual(opts.offset, 0, 'default offset must be 0');
      assert.deepStrictEqual(opts.order, [['createdAt', 'DESC']]);
      assert.deepStrictEqual(opts.where, { userId: 99 });

      // Envelope shape — not a bare array
      assert.deepStrictEqual(
        Object.keys(calls.body).sort(),
        ['limit', 'offset', 'sessions', 'total'],
        `unexpected envelope keys: ${Object.keys(calls.body).join(', ')}`
      );
      assert.strictEqual(calls.body.total, 42);
      assert.strictEqual(calls.body.limit, 50);
      assert.strictEqual(calls.body.offset, 0);
      assert.strictEqual(calls.body.sessions.length, 3);

      // Each element lacks private fields
      for (const s of calls.body.sessions) {
        assert.strictEqual(s.notes, undefined);
        assert.strictEqual(s.sessionId, undefined);
        assert.strictEqual(s.vehicleId, undefined);
        assert.strictEqual(s.vehicleName, undefined);
        assert.strictEqual(s.userId, undefined);
      }

      // Public short-lived cache header
      assert.strictEqual(calls.headers['Cache-Control'], 'public, max-age=30');

      // aggregateSummaries receives ONLY the fetched page's ids (≤ limit),
      // never the owner's full history (total=42).
      const aggCall = allCalls.find(o => o && o.where && o.where.id !== undefined);
      assert.ok(aggCall, 'aggregateSummaries should query Session by the page id list');
      assert.ok(Array.isArray(aggCall.where.id), 'aggregate where.id should be an id array');
      assert.ok(aggCall.where.id.length <= opts.limit,
        `aggregate got ${aggCall.where.id.length} ids; must be ≤ limit (${opts.limit})`);
      assert.deepStrictEqual([...aggCall.where.id].sort((a, b) => a - b), [1, 2, 3]);
    } finally {
      mockModels.User.findOne = originalUserFindOne;
      mockModels.Session.count = originalSessionCount;
      restore();
    }
  });

  it('honors ?limit=&offset= and caps limit at 200', async () => {
    const originalUserFindOne = mockModels.User.findOne;
    const originalSessionCount = mockModels.Session.count;
    mockModels.User.findOne = async () => ({ id: 99 });
    mockModels.Session.count = async () => 1000;
    const { allCalls, restore } = installFindAllCapture([]);

    try {
      // Explicit valid values pass through
      let { res, calls } = makeStubRes();
      await SessionController.getAllShared(
        { params: { shareId: 'share_abc' }, query: { limit: '10', offset: '5' } }, res);
      let handlerOpts = allCalls.filter(o => o && o.limit !== undefined).pop();
      assert.strictEqual(handlerOpts.limit, 10);
      assert.strictEqual(handlerOpts.offset, 5);
      assert.strictEqual(calls.body.limit, 10);
      assert.strictEqual(calls.body.offset, 5);

      // Cap at 200; garbage offset falls back to 0
      allCalls.length = 0;
      ({ res, calls } = makeStubRes());
      await SessionController.getAllShared(
        { params: { shareId: 'share_abc' }, query: { limit: '999999', offset: 'oops' } }, res);
      handlerOpts = allCalls.filter(o => o && o.limit !== undefined).pop();
      assert.strictEqual(handlerOpts.limit, 200, 'limit must cap at 200');
      assert.strictEqual(handlerOpts.offset, 0, 'non-numeric offset must fall back to 0');
      assert.strictEqual(calls.body.limit, 200);

      // Garbage limit falls back to the 50 default
      allCalls.length = 0;
      ({ res } = makeStubRes());
      await SessionController.getAllShared(
        { params: { shareId: 'share_abc' }, query: { limit: 'banana' } }, res);
      handlerOpts = allCalls.filter(o => o && o.limit !== undefined).pop();
      assert.strictEqual(handlerOpts.limit, 50);
    } finally {
      mockModels.User.findOne = originalUserFindOne;
      mockModels.Session.count = originalSessionCount;
      restore();
    }
  });
});

describe('shared endpoints — unknown shareId', () => {
  it('returns JSON 404 without querying sessions (negative-cache sanity)', async () => {
    const originalUserFindOne = mockModels.User.findOne;
    let sessionQueried = false;
    const originalSessionFindAll = mockModels.Session.findAll;
    const originalSessionFindOne = mockModels.Session.findOne;
    mockModels.User.findOne = async () => null;
    mockModels.Session.findAll = async () => { sessionQueried = true; return []; };
    mockModels.Session.findOne = async () => { sessionQueried = true; return {}; };

    try {
      // getAllShared
      let req = { params: { shareId: 'unknown-share-id' }, query: {} };
      let { res, calls } = makeStubRes();
      await SessionController.getAllShared(req, res);
      assert.strictEqual(calls.statusCode, 404);
      assert.deepStrictEqual(calls.body, { error: 'User not found' });

      // getOneShared
      req = { params: { shareId: 'unknown-share-id', sessionId: '42' }, query: {} };
      ({ res, calls } = makeStubRes());
      await SessionController.getOneShared(req, res);
      assert.strictEqual(calls.statusCode, 404);
      assert.deepStrictEqual(calls.body, { error: 'User not found' });

      // Neither handler may touch Session before the user check passes
      assert.strictEqual(sessionQueried, false,
        'session queries ran despite unknown shareId');
    } finally {
      mockModels.User.findOne = originalUserFindOne;
      mockModels.Session.findAll = originalSessionFindAll;
      mockModels.Session.findOne = originalSessionFindOne;
    }
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
