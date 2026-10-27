'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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
  Log: { count: async () => 0, findAll: async () => [], destroy: async () => 0 },
  User: { findOne: async () => null },
  Vehicle: { findOne: async () => null, create: async () => ({}) },
  Analysis: { findAll: async () => [], count: async () => 0 },
  sequelize: {
    transaction: async (fn) => fn({}),
    query: async () => [],
    fn: () => {},
    col: () => {},
  },
  Sequelize: { Op: { and: Symbol('and'), gt: Symbol('gt'), lte: Symbol('lte'), between: Symbol('between'), gte: Symbol('gte') } },
};
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: mockModels };

// ── Load validators and controllers ────────────────────────────────
const {
  renameSchema,
  notesSchema,
  cutSchema,
  filterSchema,
  copySchema,
  joinSchema,
  addLocationSchema,
  vehicleCreateSchema,
  vehicleUpdateSchema,
  telemetryRangeSchema,
  validateProvider,
  PROVIDER_ALLOWLIST,
  validateIds,
} = require('../lib/validators');

const SessionController = require('../controllers/SessionController');
const VehicleController = require('../controllers/VehicleController');

// ── Test helpers ──────────────────────────────────────────────────

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

// ═══════════════════════════════════════════════════════════════════
// Schema unit tests (pure Joi — no controller/mock needed)
// ═══════════════════════════════════════════════════════════════════

describe('renameSchema', () => {
  it('rejects empty string', () => {
    const { error } = renameSchema.validate({ name: '' });
    assert.ok(error);
  });

  it('rejects string > 255 chars', () => {
    const { error } = renameSchema.validate({ name: 'x'.repeat(256) });
    assert.ok(error);
  });

  it('rejects missing name', () => {
    const { error } = renameSchema.validate({});
    assert.ok(error);
  });

  it('accepts valid name', () => {
    const { error, value } = renameSchema.validate({ name: 'My Session' });
    assert.ifError(error);
    assert.strictEqual(value.name, 'My Session');
  });

  it('trims whitespace', () => {
    const { value } = renameSchema.validate({ name: '  trimmed  ' });
    assert.strictEqual(value.name, 'trimmed');
  });
});

describe('notesSchema', () => {
  it('accepts null', () => {
    const { error } = notesSchema.validate({ notes: null });
    assert.ifError(error);
  });

  it('accepts empty string', () => {
    const { error } = notesSchema.validate({ notes: '' });
    assert.ifError(error);
  });

  it('accepts string up to 10000 chars', () => {
    const { error } = notesSchema.validate({ notes: 'x'.repeat(10000) });
    assert.ifError(error);
  });

  it('rejects string > 10000 chars', () => {
    const { error } = notesSchema.validate({ notes: 'x'.repeat(10001) });
    assert.ok(error);
  });
});

describe('cutSchema', () => {
  it('rejects missing from', () => {
    const { error } = cutSchema.validate({ to: '2026-01-02T00:00:00Z' });
    assert.ok(error);
  });

  it('rejects missing to', () => {
    const { error } = cutSchema.validate({ from: '2026-01-01T00:00:00Z' });
    assert.ok(error);
  });

  it('rejects garbage date', () => {
    const { error } = cutSchema.validate({ from: 'not-a-date', to: 'also-not' });
    assert.ok(error);
  });

  it('rejects from > to', () => {
    const { error } = cutSchema.validate({
      from: '2026-01-10T00:00:00Z',
      to: '2026-01-01T00:00:00Z'
    });
    assert.ok(error);
  });

  it('accepts valid range', () => {
    const { error } = cutSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z'
    });
    assert.ifError(error);
  });

  it('accepts from === to', () => {
    const { error } = cutSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-01T00:00:00Z'
    });
    assert.ifError(error);
  });
});

describe('filterSchema', () => {
  it('rejects filterNumber 1', () => {
    const { error } = filterSchema.validate({ filterNumber: 1 });
    assert.ok(error);
  });

  it('rejects filterNumber 0', () => {
    const { error } = filterSchema.validate({ filterNumber: 0 });
    assert.ok(error);
  });

  it('rejects filterNumber -1', () => {
    const { error } = filterSchema.validate({ filterNumber: -1 });
    assert.ok(error);
  });

  it('accepts filterNumber 2', () => {
    const { error, value } = filterSchema.validate({ filterNumber: 2 });
    assert.ifError(error);
    assert.strictEqual(value.filterNumber, 2);
  });

  it('accepts filterNumber 100000', () => {
    const { error } = filterSchema.validate({ filterNumber: 100000 });
    assert.ifError(error);
  });

  it('rejects filterNumber 100001', () => {
    const { error } = filterSchema.validate({ filterNumber: 100001 });
    assert.ok(error);
  });
});

describe('copySchema', () => {
  it('rejects empty name', () => {
    const { error } = copySchema.validate({ name: '' });
    assert.ok(error);
  });

  it('accepts valid name', () => {
    const { error, value } = copySchema.validate({ name: 'Duplicated Session' });
    assert.ifError(error);
    assert.strictEqual(value.name, 'Duplicated Session');
  });
});

describe('joinSchema', () => {
  it('rejects missing joinSessionId', () => {
    const { error } = joinSchema.validate({ name: 'Joined' });
    assert.ok(error);
  });

  it('rejects missing name', () => {
    const { error } = joinSchema.validate({ joinSessionId: 5 });
    assert.ok(error);
  });

  it('rejects non-positive joinSessionId', () => {
    const { error } = joinSchema.validate({ joinSessionId: 0, name: 'Joined' });
    assert.ok(error);
  });

  it('accepts valid input', () => {
    const { error, value } = joinSchema.validate({ joinSessionId: 5, name: 'Joined' });
    assert.ifError(error);
    assert.strictEqual(value.joinSessionId, 5);
    assert.strictEqual(value.name, 'Joined');
  });
});

describe('addLocationSchema', () => {
  it('rejects missing locations', () => {
    const { error } = addLocationSchema.validate({});
    assert.ok(error);
  });

  it('rejects missing start', () => {
    const { error } = addLocationSchema.validate({ locations: { end: 'End' } });
    assert.ok(error);
  });

  it('rejects missing end', () => {
    const { error } = addLocationSchema.validate({ locations: { start: 'Start' } });
    assert.ok(error);
  });

  it('accepts valid locations', () => {
    const { error } = addLocationSchema.validate({
      locations: { start: 'Start Place', end: 'End Place' }
    });
    assert.ifError(error);
  });
});

describe('vehicleCreateSchema', () => {
  it('rejects missing name', () => {
    const { error } = vehicleCreateSchema.validate({});
    assert.ok(error);
  });

  it('rejects empty name', () => {
    const { error } = vehicleCreateSchema.validate({ name: '' });
    assert.ok(error);
  });

  it('rejects year "abc" (non-integer)', () => {
    const { error } = vehicleCreateSchema.validate({ name: 'Car', year: 'abc' });
    assert.ok(error);
  });

  it('rejects year 1800 (too low)', () => {
    const { error } = vehicleCreateSchema.validate({ name: 'Car', year: 1800 });
    assert.ok(error);
  });

  it('rejects year 2100 (too high)', () => {
    const { error } = vehicleCreateSchema.validate({ name: 'Car', year: 2100 });
    assert.ok(error);
  });

  it('accepts year 2020', () => {
    const { error, value } = vehicleCreateSchema.validate({ name: 'Car', year: 2020 });
    assert.ifError(error);
    assert.strictEqual(value.year, 2020);
  });

  it('accepts null year', () => {
    const { error } = vehicleCreateSchema.validate({ name: 'Car', year: null });
    assert.ifError(error);
  });

  it('rejects engineCc 10 (too low)', () => {
    const { error } = vehicleCreateSchema.validate({ name: 'Car', engineCc: 10 });
    assert.ok(error);
  });

  it('accepts engineCc 2000', () => {
    const { error, value } = vehicleCreateSchema.validate({ name: 'Car', engineCc: 2000 });
    assert.ifError(error);
    assert.strictEqual(value.engineCc, 2000);
  });

  it('accepts the SPA blank-vehicle payload (null make/model/year/engineCc)', () => {
    // VehicleManager always sends engineCc, null when the input is blank —
    // this exact body used to 400 on engineCc.
    const { error } = vehicleCreateSchema.validate({
      name: 'Tow Rig',
      make: null,
      model: null,
      year: null,
      engineCc: null,
    });
    assert.ifError(error);
  });
});

describe('vehicleUpdateSchema', () => {
  it('rejects empty body (min 1 field)', () => {
    const { error } = vehicleUpdateSchema.validate({});
    assert.ok(error);
  });

  it('rejects year "abc"', () => {
    const { error } = vehicleUpdateSchema.validate({ year: 'abc' });
    assert.ok(error);
  });

  it('rejects year 1800', () => {
    const { error } = vehicleUpdateSchema.validate({ year: 1800 });
    assert.ok(error);
  });

  it('accepts valid year', () => {
    const { error, value } = vehicleUpdateSchema.validate({ year: 2020 });
    assert.ifError(error);
    assert.strictEqual(value.year, 2020);
  });

  it('accepts null engineCc', () => {
    const { error } = vehicleUpdateSchema.validate({ engineCc: null });
    assert.ifError(error);
  });
});

describe('telemetryRangeSchema', () => {
  it('rejects missing from', () => {
    const { error } = telemetryRangeSchema.validate({ to: '2026-01-02T00:00:00Z' });
    assert.ok(error);
  });

  it('rejects missing to', () => {
    const { error } = telemetryRangeSchema.validate({ from: '2026-01-01T00:00:00Z' });
    assert.ok(error);
  });

  it('rejects limit -1', () => {
    const { error } = telemetryRangeSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      limit: -1
    });
    assert.ok(error);
  });

  it('rejects limit 0', () => {
    const { error } = telemetryRangeSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      limit: 0
    });
    assert.ok(error);
  });

  it('rejects limit > 10000', () => {
    const { error } = telemetryRangeSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      limit: 10001
    });
    assert.ok(error);
  });

  it('accepts limit 5000', () => {
    const { error, value } = telemetryRangeSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      limit: 5000
    });
    assert.ifError(error);
    assert.strictEqual(value.limit, 5000);
  });

  it('defaults limit to 5000', () => {
    const { error, value } = telemetryRangeSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z'
    });
    assert.ifError(error);
    assert.strictEqual(value.limit, 5000);
  });

  it('does not declare offset (cursor-based paging)', () => {
    assert.ok(!Object.keys(telemetryRangeSchema.describe().keys).includes('offset'));
    const { error } = telemetryRangeSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      offset: 100
    }, { allowUnknown: true });
    assert.ifError(error);
  });
});

describe('validateProvider', () => {
  it('returns ok for undefined', () => {
    assert.deepStrictEqual(validateProvider(undefined), { ok: true });
  });

  it('returns ok for null', () => {
    assert.deepStrictEqual(validateProvider(null), { ok: true });
  });

  it('returns ok for valid provider "openai"', () => {
    assert.deepStrictEqual(validateProvider('openai'), { ok: true });
  });

  it('returns ok for all valid providers', () => {
    for (const p of PROVIDER_ALLOWLIST) {
      assert.deepStrictEqual(validateProvider(p), { ok: true }, `Provider "${p}" should be valid`);
    }
  });

  it('rejects invalid provider', () => {
    const r = validateProvider('invalid-provider');
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('llmProvider must be one of'));
  });

  it('rejects "Invalid" (wrong case)', () => {
    const r = validateProvider('Invalid');
    assert.strictEqual(r.ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Controller integration tests (mocked models — verify 400 response)
// ═══════════════════════════════════════════════════════════════════

describe('SessionController rename validation', () => {
  it('returns 400 for empty name', async () => {
    const req = makeStubReq({ body: { name: '' } });
    const { res, calls } = makeStubRes();
    await SessionController.rename(req, res);
    assert.strictEqual(calls.statusCode, 400);
    assert.ok(calls.body.error);
  });

  it('returns 400 for name > 255 chars', async () => {
    const req = makeStubReq({ body: { name: 'x'.repeat(256) } });
    const { res, calls } = makeStubRes();
    await SessionController.rename(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  it('passes valid name through to Session.update', async () => {
    let capturedData = null;
    mockModels.Session.update = async (data, _opts) => { capturedData = data; return [1]; };
    const req = makeStubReq({ body: { name: 'Valid Name' } });
    const { res, calls } = makeStubRes();
    await SessionController.rename(req, res);
    assert.strictEqual(calls.statusCode, 200);
    assert.strictEqual(capturedData.name, 'Valid Name');
    mockModels.Session.update = async () => [0];
  });
});

describe('SessionController cut validation', () => {
  it('returns 400 for missing from/to', async () => {
    const req = makeStubReq({ body: {} });
    const { res, calls } = makeStubRes();
    await SessionController.cut(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  it('returns 400 for garbage dates', async () => {
    const req = makeStubReq({ body: { from: 'garbage', to: 'also-garbage' } });
    const { res, calls } = makeStubRes();
    await SessionController.cut(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  it('returns 400 when from > to', async () => {
    const req = makeStubReq({
      body: { from: '2026-01-10T00:00:00Z', to: '2026-01-01T00:00:00Z' }
    });
    const { res, calls } = makeStubRes();
    await SessionController.cut(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });
});

describe('SessionController filter validation', () => {
  it('returns 400 for filterNumber < 2', async () => {
    const req = makeStubReq({ body: { filterNumber: 1 } });
    const { res, calls } = makeStubRes();
    await SessionController.filter(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  it('returns 400 for filterNumber 0', async () => {
    const req = makeStubReq({ body: { filterNumber: 0 } });
    const { res, calls } = makeStubRes();
    await SessionController.filter(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  it('returns 400 for negative filterNumber', async () => {
    const req = makeStubReq({ body: { filterNumber: -1 } });
    const { res, calls } = makeStubRes();
    await SessionController.filter(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });
});

describe('SessionController copy validation', () => {
  it('returns 400 for empty name', async () => {
    const req = makeStubReq({ body: { name: '' } });
    const { res, calls } = makeStubRes();
    await SessionController.copy(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  it('returns 400 for missing name', async () => {
    const req = makeStubReq({ body: {} });
    const { res, calls } = makeStubRes();
    await SessionController.copy(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });
});

describe('SessionController join validation', () => {
  it('returns 400 for missing joinSessionId', async () => {
    const req = makeStubReq({ body: { name: 'Joined' } });
    const { res, calls } = makeStubRes();
    await SessionController.join(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  it('returns 400 for missing name', async () => {
    const req = makeStubReq({ body: { joinSessionId: 5 } });
    const { res, calls } = makeStubRes();
    await SessionController.join(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });
});

describe('SessionController addLocation validation', () => {
  it('returns 400 for missing locations', async () => {
    mockModels.Session.findOne = async () => ({ id: 1 });
    const req = makeStubReq({ body: {} });
    const { res, calls } = makeStubRes();
    await SessionController.addLocation(req, res);
    assert.strictEqual(calls.statusCode, 400);
    mockModels.Session.findOne = async () => null;
  });

  it('returns 400 for missing locations.start', async () => {
    mockModels.Session.findOne = async () => ({ id: 1 });
    const req = makeStubReq({ body: { locations: { end: 'End' } } });
    const { res, calls } = makeStubRes();
    await SessionController.addLocation(req, res);
    assert.strictEqual(calls.statusCode, 400);
    mockModels.Session.findOne = async () => null;
  });
});

describe('SessionController updateNotes validation', () => {
  it('returns 400 for non-string notes', async () => {
    const req = makeStubReq({ body: { notes: 123 } });
    const { res, calls } = makeStubRes();
    await SessionController.updateNotes(req, res);
    assert.strictEqual(calls.statusCode, 400);
  });

  it('accepts null notes', async () => {
    mockModels.Session.findOne = async () => ({ id: 1, notes: null, update: async (_d) => { mockModels.Session.findOne = async () => null; } });
    const req = makeStubReq({ body: { notes: null } });
    const { res, calls } = makeStubRes();
    await SessionController.updateNotes(req, res);
    // Should not be 400 — notes:null is valid
    assert.notStrictEqual(calls.statusCode, 400);
    mockModels.Session.findOne = async () => null;
  });
});

describe('validateIds', () => {
  function run(params, keys = ['sessionId']) {
    const req = { params };
    const { res, calls } = makeStubRes();
    let nextCalled = false;
    validateIds(...keys)(req, res, () => { nextCalled = true; });
    return { calls, nextCalled };
  }

  for (const bad of ['abc', '0', '-1', '1.5', '12abc', '']) {
    it(`rejects ${JSON.stringify(bad)} with 400`, () => {
      const { calls, nextCalled } = run({ sessionId: bad });
      assert.strictEqual(calls.statusCode, 400);
      assert.deepStrictEqual(calls.body, { error: 'Invalid sessionId.' });
      assert.strictEqual(nextCalled, false);
    });
  }

  it('rejects a missing param', () => {
    const { calls, nextCalled } = run({});
    assert.strictEqual(calls.statusCode, 400);
    assert.strictEqual(nextCalled, false);
  });

  it('accepts a positive integer id', () => {
    const { calls, nextCalled } = run({ sessionId: '42' });
    assert.strictEqual(calls.statusCode, null);
    assert.strictEqual(nextCalled, true);
  });

  it('accepts the largest int4 id', () => {
    const { calls, nextCalled } = run({ sessionId: '2147483647' });
    assert.strictEqual(calls.statusCode, null);
    assert.strictEqual(nextCalled, true);
  });

  for (const bad of ['2147483648', '9'.repeat(20)]) {
    it(`rejects int4 overflow ${bad} with 400`, () => {
      const { calls, nextCalled } = run({ sessionId: bad });
      assert.strictEqual(calls.statusCode, 400);
      assert.deepStrictEqual(calls.body, { error: 'Invalid sessionId.' });
      assert.strictEqual(nextCalled, false);
    });
  }

  it('checks every named param', () => {
    const { calls, nextCalled } = run({ sessionId: '1', analysisId: 'nope' }, ['sessionId', 'analysisId']);
    assert.strictEqual(calls.statusCode, 400);
    assert.deepStrictEqual(calls.body, { error: 'Invalid analysisId.' });
    assert.strictEqual(nextCalled, false);
  });
});

describe('list pagination clamps', () => {
  async function listArgs(query) {
    let captured = null;
    mockModels.User.findOne = async () => ({ id: 1 });
    mockModels.Session.findAll = async (opts) => { captured = opts; return []; };
    mockModels.Session.count = async () => 0;
    try {
      const req = makeStubReq({ params: {}, query });
      const { res } = makeStubRes();
      await SessionController.getAll(req, res);
      return captured;
    } finally {
      mockModels.User.findOne = async () => null;
      mockModels.Session.findAll = async () => [];
      mockModels.Session.count = async () => 0;
    }
  }

  it('limit=-1 clamps to 1', async () => {
    assert.strictEqual((await listArgs({ limit: '-1' })).limit, 1);
  });

  it('limit=0 falls back to 50', async () => {
    assert.strictEqual((await listArgs({ limit: '0' })).limit, 50);
  });

  it('limit=9999 clamps to 200', async () => {
    assert.strictEqual((await listArgs({ limit: '9999' })).limit, 200);
  });

  it('offset=-5 clamps to 0', async () => {
    assert.strictEqual((await listArgs({ offset: '-5' })).offset, 0);
  });

  it('offset=abc falls back to 0', async () => {
    assert.strictEqual((await listArgs({ offset: 'abc' })).offset, 0);
  });
});

describe('SessionController vehicleId query gate', () => {
  function run(query) {
    const req = makeStubReq({ params: {}, query });
    const { res, calls } = makeStubRes();
    return { req, res, calls };
  }

  for (const bad of ['abc', '1.5', '0', '-1', '2147483648', '9'.repeat(20)]) {
    it(`returns 400 for vehicleId=${bad} before any DB access`, async () => {
      let userLookedUp = false;
      mockModels.User.findOne = async () => { userLookedUp = true; return { id: 1 }; };
      try {
        const { req, res, calls } = run({ vehicleId: bad });
        await SessionController.getAll(req, res);
        assert.strictEqual(calls.statusCode, 400);
        assert.deepStrictEqual(calls.body, { error: 'Invalid vehicleId.' });
        assert.strictEqual(userLookedUp, false, 'the gate must run before the DB');
      } finally {
        mockModels.User.findOne = async () => null;
      }
    });
  }

  it('passes none, a valid int4 id and an absent filter through', async () => {
    const wheres = [];
    mockModels.User.findOne = async () => ({ id: 1 });
    mockModels.Session.findAll = async (opts) => { wheres.push(opts.where); return []; };
    mockModels.Session.count = async () => 0;
    try {
      for (const query of [{ vehicleId: 'none' }, { vehicleId: '42' }, {}]) {
        const { req, res, calls } = run(query);
        await SessionController.getAll(req, res);
        assert.notStrictEqual(calls.statusCode, 400, JSON.stringify(query));
      }
    } finally {
      mockModels.User.findOne = async () => null;
      mockModels.Session.findAll = async () => [];
      mockModels.Session.count = async () => 0;
    }
    assert.deepStrictEqual(wheres, [
      { userId: 1, vehicleId: null },
      { userId: 1, vehicleId: 42 },
      { userId: 1 },
    ]);
  });
});

describe('VehicleController body validation', () => {
  it('rejects create with a non-integer year as 400 JSON', async () => {
    const req = makeStubReq({ params: {}, body: { name: 'Car', year: 'abc' } });
    const { res, calls } = makeStubRes();
    await VehicleController.create(req, res);
    assert.strictEqual(calls.statusCode, 400);
    assert.strictEqual(typeof calls.body.error, 'string');
  });

  it('rejects update with an empty body as 400 JSON', async () => {
    const req = makeStubReq({ body: {} });
    const { res, calls } = makeStubRes();
    await VehicleController.update(req, res);
    assert.strictEqual(calls.statusCode, 400);
    assert.strictEqual(typeof calls.body.error, 'string');
  });
});

describe('route wiring — id params', () => {
  it('gates every id-bearing /api route with validateIds for its own :params', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'api.js'), 'utf8');
    const idRoutes = src.split('\n').filter((line) => /^router\.\w+\(.*:\w+/.test(line));
    assert.strictEqual(idRoutes.length, 21);
    for (const line of idRoutes) {
      assert.match(line, /validateIds\(/, `missing validateIds: ${line.trim()}`);
      // The guard must cover exactly the route's declared path params, in
      // order — otherwise a renamed param (e.g. :id → :sessionId) silently
      // validates a key that is always undefined and 400s every request.
      const pathMatch = line.match(/^router\.\w+\(\s*'([^']+)'/);
      assert.ok(pathMatch, `unparsable route path: ${line.trim()}`);
      const paramNames = [...pathMatch[1].matchAll(/:(\w+)/g)].map((m) => m[1]);
      const argsMatch = line.match(/validateIds\(([^)]*)\)/);
      const args = [...argsMatch[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
      assert.deepStrictEqual(args, paramNames, `validateIds args must match route params: ${line.trim()}`);
    }
  });
});


