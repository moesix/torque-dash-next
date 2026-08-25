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
  Log: { count: async () => 0, findAll: async () => [], destroy: async () => 0 },
  User: { findOne: async () => null },
  Vehicle: { findOne: async () => null },
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
} = require('../lib/validators');

const SessionController = require('../controllers/SessionController');

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
    const { error, value } = copySchema.validate({ name: 'Copy of Session' });
    assert.ifError(error);
    assert.strictEqual(value.name, 'Copy of Session');
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

  it('rejects negative offset', () => {
    const { error } = telemetryRangeSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      offset: -1
    });
    assert.ok(error);
  });

  it('defaults offset to 0', () => {
    const { error, value } = telemetryRangeSchema.validate({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z'
    });
    assert.ifError(error);
    assert.strictEqual(value.offset, 0);
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
