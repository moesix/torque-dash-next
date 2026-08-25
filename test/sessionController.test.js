'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// ── Pre-populate require.cache for ../models ────────────────────────
// SessionController requires ../models at the top level.  models/index.js
// creates a real Sequelize instance, which we don't need in unit tests.
// We pre-populate the require cache with mock models so the controller
// gets our stubs instead of loading the real module.

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
  User: { findOne: async () => null },
  Vehicle: { findOne: async () => null },
  sequelize: {
    transaction: async (fn) => fn({}),
    query: async () => [],
    fn: () => {},
    col: () => {},
  },
  Sequelize: { Op: { and: Symbol('and'), gt: Symbol('gt'), lte: Symbol('lte') } },
};

// Resolve the absolute path that `require('../models')` resolves to from
// controllers/SessionController.js, then inject our mock into the cache.
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath,
  filename: modelsPath,
  loaded: true,
  exports: mockModels,
};

// ── Now safe to require the controller ──────────────────────────────
const SessionController = require('../controllers/SessionController');

// ── Helpers ─────────────────────────────────────────────────────────

function makeStubReq(overrides = {}) {
  return {
    user: { id: 1 },
    params: { sessionId: 's1' },
    body: {},
    query: {},
    ...overrides,
  };
}

function makeStubRes() {
  const calls = { status: null, body: null, statusCode: null };
  const res = {
    status(code) { calls.statusCode = code; calls.status = code; return res; },
    json(obj) { calls.body = obj; return res; },
    sendStatus(code) { calls.statusCode = code; calls.status = code; return res; },
    send(data) { calls.body = data; return res; },
    setHeader() { return res; },
    set() { return res; },
    write() { return res; },
    end() { return res; },
  };
  return { res, calls };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('SessionController (with mocked models)', () => {

  // ── rename ──────────────────────────────────────────────────────

  test('rename returns 404 when affectedCount is 0', async () => {
    const req = makeStubReq({ params: { sessionId: 'nonexistent' }, body: { name: 'New' } });
    const { res, calls } = makeStubRes();
    await SessionController.rename(req, res);
    assert.strictEqual(calls.statusCode, 404);
  });

  // ── updateNotes ─────────────────────────────────────────────────

  test('updateNotes returns 400 for non-string notes', async () => {
    const req = makeStubReq({ body: { notes: 123 } });
    const { res, calls } = makeStubRes();
    await SessionController.updateNotes(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  // ── cut validation ──────────────────────────────────────────────

  test('cut returns 400 when from is missing', async () => {
    const req = makeStubReq({ body: { to: '2026-01-02' } });
    const { res, calls } = makeStubRes();
    await SessionController.cut(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  test('cut returns 400 when to is missing', async () => {
    const req = makeStubReq({ body: { from: '2026-01-01' } });
    const { res, calls } = makeStubRes();
    await SessionController.cut(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  test('cut returns 400 when dates are garbage', async () => {
    const req = makeStubReq({ body: { from: 'not-a-date', to: 'also-not' } });
    const { res, calls } = makeStubRes();
    await SessionController.cut(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  test('cut returns 400 when from > to', async () => {
    const req = makeStubReq({ body: { from: '2026-01-10', to: '2026-01-01' } });
    const { res, calls } = makeStubRes();
    await SessionController.cut(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  // ── filter validation ───────────────────────────────────────────

  test('filter returns 400 when filterNumber < 2', async () => {
    const req = makeStubReq({ body: { filterNumber: 1 } });
    const { res, calls } = makeStubRes();
    await SessionController.filter(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  // ── delete ──────────────────────────────────────────────────────
  // NOTE: current code returns 401 (not 404) when session is not found.
  // The status code fix is deferred to plan 063; we assert what EXISTS.

  test('delete returns 401 when session not found (ownership miss)', async () => {
    const req = makeStubReq({ params: { sessionId: 'nonexistent' } });
    const { res, calls } = makeStubRes();
    await SessionController.delete(req, res);
    assert.strictEqual(calls.statusCode, 401);
    assert.strictEqual(calls.body, 'Session not found');
  });
});
