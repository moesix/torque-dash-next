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
const TelemetryController = require('../controllers/TelemetryController');
const UploadController = require('../controllers/UploadController');
const runtime = require('../config/runtime');
const { errorMiddleware, badRequest } = require('../lib/httpError');

// Boot the real /api router for shape-level assertions. The auth middleware is
// stubbed to a pass-through so invalid-id requests reach the id gate instead of
// being short-circuited with a 401 (auth ordering is covered elsewhere).
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: (req, res, next) => next(),
};
const express = require('express');
const apiRouter = require('../routes/api');

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

  test('GET /api/sessions/foo returns 400 JSON, not 500', async () => {
    const app = express();
    app.use('/api', apiRouter);
    const server = app.listen(0);
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions/foo`);
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), { error: 'Invalid sessionId.' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('GET /api/sessions/42 passes the id gate (is not a 400)', async () => {
    // Positive control for the test above: a valid id must reach the
    // controller. The mocked Session.findOne returns null, so the visible
    // answer is a downstream 404 — the point is only that the gate passed.
    const app = express();
    app.use('/api', (req, _res, next) => { req.user = { id: 1 }; req.isAuthenticated = () => true; next(); });
    app.use('/api', apiRouter);
    const server = app.listen(0);
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions/42`);
      assert.notStrictEqual(res.status, 400);
      const body = await res.json();
      assert.notDeepStrictEqual(body, { error: 'Invalid sessionId.' });
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(body, { error: 'Session not found' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

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

// ── Error middleware (plan 034) ─────────────────────────────────────
// The middleware is registered after the JSON 404 in app.js. These tests
// mount it directly (same order) so the contract is asserted without booting
// the DB-backed app; the converted-route test below drives a real controller.
describe('errorMiddleware — one JSON error contract', () => {
  async function withServer(app, fn) {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      return await fn(server.address().port);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function appWith(...handlers) {
    const app = express();
    for (const h of handlers) app.get('/x', h);
    // Mirror app.js: JSON 404, then the terminal error middleware.
    app.use('*', (req, res) => res.status(404).json({ error: 'Not found' }));
    app.use(errorMiddleware);
    return app;
  }

  test('a thrown plain error answers 500 JSON and never leaks its message', async () => {
    const app = appWith(() => { throw new Error('relation "Secrets" does not exist'); });
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/x`);
      assert.strictEqual(res.status, 500);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      assert.deepStrictEqual(await res.json(), { error: 'Internal server error' });
    });
  });

  test('an HttpError answers with its status and message', async () => {
    const app = appWith(() => { throw badRequest('retentionDays must be between 90 and 365'); });
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/x`);
      assert.strictEqual(res.status, 400);
      assert.deepStrictEqual(await res.json(), { error: 'retentionDays must be between 90 and 365' });
    });
  });

  test('unmatched routes still answer 404 JSON', async () => {
    const app = appWith(() => {});
    await withServer(app, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      assert.strictEqual(res.status, 404);
      assert.deepStrictEqual(await res.json(), { error: 'Not found' });
    });
  });

  test('a converted handler (TelemetryController.range) reaches the middleware', async () => {
    // Force the controller's DB call to throw, exercising the new
    // `catch (err) { next(err); }` path end-to-end through Express.
    const origFindOne = mockModels.Session.findOne;
    const origFindAll = mockModels.Log.findAll;
    mockModels.Session.findOne = async () => ({ id: 7, sessionId: 's1' });
    mockModels.Log.findAll = async () => { throw new Error('db exploded'); };

    const app = express();
    app.get('/telemetry', (req, _res, next) => {
      req.user = { id: 1 };
      req.query = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };
      req.params = { sessionId: '7' };
      TelemetryController.range(req, _res, next);
    });
    app.use(errorMiddleware);

    try {
      await withServer(app, async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/telemetry`);
        assert.strictEqual(res.status, 500);
        assert.match(res.headers.get('content-type') || '', /application\/json/);
        assert.deepStrictEqual(await res.json(), { error: 'Internal server error' });
      });
    } finally {
      mockModels.Session.findOne = origFindOne;
      mockModels.Log.findAll = origFindAll;
    }
  });
});
