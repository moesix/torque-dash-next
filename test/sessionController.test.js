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
  // Fix: now returns 404 JSON (not 401) when session is not found.

  test('delete returns 404 JSON when session not found (ownership miss)', async () => {
    const req = makeStubReq({ params: { sessionId: 'nonexistent' } });
    const { res, calls } = makeStubRes();
    await SessionController.delete(req, res);
    assert.strictEqual(calls.statusCode, 404);
    assert.deepStrictEqual(calls.body, { error: 'Session not found' });
  });
});

// ── reassignVehicle — ownership + IDOR guard ────────────────────────
// PATCH /api/sessions/:sessionId/vehicle. The vehicle must belong to the
// caller AND the session must belong to the caller; both checks happen before
// any write, so one user can never reassign another user's session to one of
// their vehicles (or clear a foreign session's vehicle).

describe('SessionController reassignVehicle (ownership guard)', () => {
  const DEFAULT_VEHICLE_FIND_ONE = async () => null;
  const DEFAULT_SESSION_FIND_ONE = async () => null;
  const VEHICLE_FOREIGN_MSG = 'Vehicle not found.';
  const SESSION_FOREIGN_MSG = 'Session not found';

  function installMocks({ vehicle = null, session = null } = {}) {
    const calls = { vehicleFindOne: [], sessionFindOne: [], sessionUpdates: [] };
    mockModels.Vehicle.findOne = async (opts) => { calls.vehicleFindOne.push(opts); return vehicle; };
    mockModels.Session.findOne = async (opts) => { calls.sessionFindOne.push(opts); return session; };
    return calls;
  }

  function restoreMocks() {
    mockModels.Vehicle.findOne = DEFAULT_VEHICLE_FIND_ONE;
    mockModels.Session.findOne = DEFAULT_SESSION_FIND_ONE;
  }

  // A minimal Sequelize-like session instance: update() patches the in-memory
  // vehicleId and records the call, so res.json sees the post-update value.
  function makeOwnedSession(id = 's1', vehicleId = null) {
    const sess = { id, vehicleId };
    sess.update = async (patch) => {
      sess.vehicleId = patch.vehicleId;
      return sess;
    };
    return sess;
  }

  test('rejects vehicleId "abc", 0 and -1 with 400 before any DB access', async () => {
    try {
      for (const bad of ['abc', 0, -1]) {
        const calls = installMocks();
        const req = makeStubReq({ body: { vehicleId: bad } });
        const { res, calls: out } = makeStubRes();
        await SessionController.reassignVehicle(req, res);
        assert.strictEqual(out.statusCode, 400, `vehicleId=${JSON.stringify(bad)}`);
        assert.deepStrictEqual(out.body, { error: 'vehicleId must be a positive integer or null.' });
        assert.strictEqual(calls.vehicleFindOne.length, 0, 'no vehicle lookup for an invalid id');
        assert.strictEqual(calls.sessionFindOne.length, 0, 'no session lookup for an invalid id');
      }
    } finally {
      restoreMocks();
    }
  });

  test('a foreign vehicle (not owned by the caller) returns 404 and never touches the session', async () => {
    try {
      // User 1 tries to assign someone else's vehicle (id 99) to their session.
      const calls = installMocks({ vehicle: null });
      const req = makeStubReq({ body: { vehicleId: 99 } });
      const { res, calls: out } = makeStubRes();
      await SessionController.reassignVehicle(req, res);

      assert.strictEqual(out.statusCode, 404);
      assert.deepStrictEqual(out.body, { error: VEHICLE_FOREIGN_MSG });
      // The vehicle lookup is ownership-scoped — this is the IDOR guard.
      assert.deepStrictEqual(calls.vehicleFindOne[0], { where: { id: 99, userId: 1 } });
      assert.strictEqual(calls.sessionFindOne.length, 0, 'session must not be loaded when the vehicle is foreign');
    } finally {
      restoreMocks();
    }
  });

  test('valid owned vehicle updates the owned session and responds { ok: true, vehicleId }', async () => {
    try {
      const updateResults = [];
      const session = makeOwnedSession('s1');
      session.update = async (patch) => {
        updateResults.push(patch);
        session.vehicleId = patch.vehicleId;
        return session;
      };
      const calls = installMocks({ vehicle: { id: 5 }, session });
      const req = makeStubReq({ body: { vehicleId: 5 } });
      const { res, calls: out } = makeStubRes();
      await SessionController.reassignVehicle(req, res);

      assert.deepStrictEqual(calls.vehicleFindOne[0], { where: { id: 5, userId: 1 } });
      assert.deepStrictEqual(calls.sessionFindOne[0], { where: { id: 's1', userId: 1 } }, 'session lookup must be ownership-scoped');
      assert.deepStrictEqual(updateResults, [{ vehicleId: 5 }], 'update must carry the numeric vehicleId');
      assert.deepStrictEqual(out.body, { ok: true, vehicleId: 5 });
    } finally {
      restoreMocks();
    }
  });

  test('vehicleId null (unassign) clears the vehicle without a vehicle lookup', async () => {
    try {
      const updateResults = [];
      const session = makeOwnedSession('s1', 5);
      session.update = async (patch) => {
        updateResults.push(patch);
        session.vehicleId = patch.vehicleId;
        return session;
      };
      const calls = installMocks({ vehicle: { id: 5 }, session });
      const req = makeStubReq({ body: { vehicleId: null } });
      const { res, calls: out } = makeStubRes();
      await SessionController.reassignVehicle(req, res);

      assert.strictEqual(calls.vehicleFindOne.length, 0, 'unassign needs no vehicle ownership check');
      assert.deepStrictEqual(updateResults, [{ vehicleId: null }]);
      assert.deepStrictEqual(out.body, { ok: true, vehicleId: null });
    } finally {
      restoreMocks();
    }
  });

  test('a foreign session returns 404 and never updates (no cross-owner write)', async () => {
    try {
      // Vehicle is owned, but the session belongs to another user: Session.findOne
      // (scoped by userId) returns nothing → 404 and no update call.
      const calls = installMocks({ vehicle: { id: 5 }, session: null });
      const req = makeStubReq({ params: { sessionId: 'foreign-session' }, body: { vehicleId: 5 } });
      const { res, calls: out } = makeStubRes();
      await SessionController.reassignVehicle(req, res);

      assert.strictEqual(out.statusCode, 404);
      assert.deepStrictEqual(out.body, { error: SESSION_FOREIGN_MSG });
      assert.deepStrictEqual(calls.sessionFindOne[0], { where: { id: 'foreign-session', userId: 1 } });
      assert.strictEqual(calls.sessionUpdates.length, 0);
    } finally {
      restoreMocks();
    }
  });
});
