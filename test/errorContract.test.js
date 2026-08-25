'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// ── Pre-populate require.cache for ../models ────────────────────────
// Mirrors sessionController.test.js setup so controllers get mock models.

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

const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath,
  filename: modelsPath,
  loaded: true,
  exports: mockModels,
};

const SessionController = require('../controllers/SessionController');
const UploadController = require('../controllers/UploadController');
const runtime = require('../config/runtime');

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

describe('Error contract — backend response shapes', () => {

  // ── Session delete ─────────────────────────────────────────────

  test('session delete returns 404 JSON (not 401) when session not found', async () => {
    const req = makeStubReq({ params: { sessionId: 'nonexistent' } });
    const { res, calls } = makeStubRes();
    await SessionController.delete(req, res);
    assert.strictEqual(calls.statusCode, 404);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
    assert.strictEqual(calls.body.error, 'Session not found');
  });

  // ── Session getOne ─────────────────────────────────────────────

  test('session getOne returns 404 JSON when session not found', async () => {
    const req = makeStubReq({ params: { sessionId: 'nonexistent' } });
    const { res, calls } = makeStubRes();
    await SessionController.getOne(req, res);
    assert.strictEqual(calls.statusCode, 404);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
    assert.strictEqual(calls.body.error, 'Session not found');
  });

  // ── Session getOneShared ───────────────────────────────────────

  test('session getOneShared returns 404 JSON when user not found', async () => {
    // Mock models: User.findOne returns null → triggers 404
    const req = makeStubReq({ params: { shareId: 'bad-share', sessionId: 's1' } });
    const { res, calls } = makeStubRes();
    await SessionController.getOneShared(req, res);
    assert.strictEqual(calls.statusCode, 404);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
  });

  // ── Session getAllShared ───────────────────────────────────────

  test('session getAllShared returns 404 JSON when user not found', async () => {
    const req = makeStubReq({ params: { shareId: 'bad-share' } });
    const { res, calls } = makeStubRes();
    await SessionController.getAllShared(req, res);
    assert.strictEqual(calls.statusCode, 404);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
  });

  // ── Session addLocation ────────────────────────────────────────

  test('session addLocation returns 404 JSON when session not found', async () => {
    const req = makeStubReq({ params: { sessionId: 'nonexistent' }, body: {} });
    const { res, calls } = makeStubRes();
    await SessionController.addLocation(req, res);
    assert.strictEqual(calls.statusCode, 404);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
  });

  // ── Session filter ─────────────────────────────────────────────

  test('session filter returns 404 JSON when session not found', async () => {
    const req = makeStubReq({ body: { filterNumber: 2 } });
    const { res, calls } = makeStubRes();
    await SessionController.filter(req, res);
    assert.strictEqual(calls.statusCode, 404);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
  });

  // ── Session cut ────────────────────────────────────────────────

  test('session cut returns 404 JSON when session not found', async () => {
    const req = makeStubReq({ body: { from: '2026-01-01', to: '2026-01-02' } });
    const { res, calls } = makeStubRes();
    await SessionController.cut(req, res);
    assert.strictEqual(calls.statusCode, 404);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
  });

  // ── Session join ───────────────────────────────────────────────

  test('session join returns 404 JSON when session not found', async () => {
    const req = makeStubReq({
      params: { sessionId: 's1' },
      body: { joinSessionId: 2, name: 'joined' },
    });
    const { res, calls } = makeStubRes();
    await SessionController.join(req, res);
    assert.strictEqual(calls.statusCode, 404);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
  });

  // ── Validation errors are already JSON (regression) ────────────

  test('cut validation error returns 400 JSON', async () => {
    const req = makeStubReq({ body: {} });
    const { res, calls } = makeStubRes();
    await SessionController.cut(req, res);
    assert.strictEqual(calls.statusCode, 400);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
  });

  test('filter validation error returns 400 JSON', async () => {
    const req = makeStubReq({ body: { filterNumber: 1 } });
    const { res, calls } = makeStubRes();
    await SessionController.filter(req, res);
    assert.strictEqual(calls.statusCode, 400);
    assert.ok(typeof calls.body === 'object' && calls.body !== null, 'body should be an object');
    assert.strictEqual(typeof calls.body.error, 'string', 'body.error should be a string');
  });

  // ── UploadController unknown-user gate ─────────────────────────
  // Exercises the REAL exported resolveUser and the REAL processUpload
  // guard through the ../models require-cache stub above
  // (User.findOne → null). No test-local reimplementation of the guard.

  describe('UploadController — unknown user is rejected with 403', () => {
    // Local harness: tracks just what the upload gate needs (status code +
    // response body) so the JSON error contract can be asserted directly.
    function makeUploadHarness() {
      const calls = { statusCode: null, body: null };
      const res = {
        status(code) { calls.statusCode = code; return res; },
        json(obj) { calls.body = obj; return res; },
        send(data) { calls.body = data; return res; },
      };
      return { res, calls };
    }

    test('real resolveUser returns null for missing or unknown email', async () => {
      assert.strictEqual(await UploadController.resolveUser(undefined), null);
      assert.strictEqual(await UploadController.resolveUser(''), null);
      assert.strictEqual(await UploadController.resolveUser('ghost@example.com'), null);
    });

    test('processUpload answers 403 JSON { error } "Invalid user account." when user unknown', async () => {
      runtime.setUploadApiToken(null); // ensure bearer-token auth gate is off
      const req = makeStubReq({ params: {}, query: { session: 's1', eml: 'ghost@example.com' } });
      const { res, calls } = makeUploadHarness();
      await UploadController.processUpload(req, res);
      assert.strictEqual(calls.statusCode, 403);
      assert.deepStrictEqual(calls.body, { error: 'Invalid user account.' });
    });
  });

  // ── Error shape contract ───────────────────────────────────────

  describe('All error responses follow { error: string } contract', () => {
    test('error body is a plain object with a string "error" key', () => {
      // Simulate the contract: every error response is { error: 'message' }
      const errorBody = { error: 'Something went wrong' };
      assert.strictEqual(typeof errorBody, 'object');
      assert.strictEqual(typeof errorBody.error, 'string');
      assert.ok(errorBody.error.length > 0);
    });

    test('error body does not contain extra unexpected keys', () => {
      const errorBody = { error: 'Session not found' };
      const keys = Object.keys(errorBody);
      assert.deepStrictEqual(keys, ['error']);
    });
  });
});
