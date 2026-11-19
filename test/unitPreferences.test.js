'use strict';

// Plan 045 — per-user unit preference: migration shape, GET/PUT matrix,
// null → inherit, cache invalidation, and DEFAULT_UNIT_SYSTEM resolution.

// Dummy env BEFORE config.js loads (it throws without these).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadWithMocks } = require('./support/loadWithMocks');

const ROOT = path.resolve(__dirname, '..');

// ── Migration SQL (static) ───────────────────────────────────────────

describe('migration 028_unit_preferences.sql', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'infra/timescale/028_unit_preferences.sql'),
    'utf8',
  );

  it('adds a nullable Users.unitSystem column', () => {
    assert.match(sql, /ALTER TABLE "Users" ADD COLUMN IF NOT EXISTS "unitSystem" VARCHAR\(16\) NULL/);
  });

  it('adds a nullable Analyses.unitSystem column with no CHECK', () => {
    assert.match(sql, /ALTER TABLE "Analyses" ADD COLUMN IF NOT EXISTS "unitSystem" VARCHAR\(16\) NULL/);
    assert.doesNotMatch(sql, /Analyses_unitSystem_check/);
  });

  it('guards the Users CHECK constraint', () => {
    assert.match(sql, /Users_unitSystem_check/);
    assert.match(sql, /"unitSystem" IS NULL OR "unitSystem" IN \('metric','us','uk'\)/);
  });
});

// ── Controller behavior (mocked models/passport) ─────────────────────

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    vary() { return this; },
  };
}

function loadController(defaultSystem) {
  const userUpdates = [];
  const cacheDels = [];
  const mocks = [
    {
      path: '../models',
      exports: {
        User: {
          update: async (values, opts) => {
            userUpdates.push({ values, opts });
            return [1];
          },
          findByPk: async () => null,
          findOne: async () => null,
          count: async () => 1,
        },
        Settings: { getSingleton: async () => ({}) },
        Session: {},
        Log: {},
        Vehicle: {},
        Analysis: {},
        sequelize: { query: async () => [], transaction: async () => 0 },
      },
    },
    {
      path: '../config/passport',
      exports: { userByIdCache: { del: (id) => cacheDels.push(id) } },
    },
  ];

  // config.py validates DEFAULT_UNIT_SYSTEM at load; set it BEFORE the
  // controller (and its purged config dependency) is required.
  const previous = process.env.DEFAULT_UNIT_SYSTEM;
  if (defaultSystem === undefined) delete process.env.DEFAULT_UNIT_SYSTEM;
  else process.env.DEFAULT_UNIT_SYSTEM = defaultSystem;

  const loaded = loadWithMocks(
    '../controllers/UserController',
    mocks,
    ['../config/config', '../lib/units', '../lib/validators', '../config/runtime'],
  );

  if (previous === undefined) delete process.env.DEFAULT_UNIT_SYSTEM;
  else process.env.DEFAULT_UNIT_SYSTEM = previous;

  return { UserController: loaded.module, restore: loaded.restore, userUpdates, cacheDels };
}

describe('GET/PUT /api/users/preferences (controller)', () => {
  let ctx;
  beforeEach(() => {
    ctx = loadController();
  });

  const user = (unitSystem) => ({ id: 7, unitSystem, isAdmin: false });

  it('GET resolves NULL to the env default and reports serverDefault', async () => {
    const res = makeRes();
    await ctx.UserController.getPreferences({ user: user(null) }, res, () => {});
    assert.strictEqual(res.body.unitSystem, 'metric');
    assert.strictEqual(res.body.serverDefault, 'metric');
  });

  it('GET returns an explicit user value over the default', async () => {
    const res = makeRes();
    await ctx.UserController.getPreferences({ user: user('uk') }, res, () => {});
    assert.strictEqual(res.body.unitSystem, 'uk');
  });

  it('PUT us → 200, writes the row, invalidates the cache', async () => {
    const res = makeRes();
    const req = { user: user(null), body: { unitSystem: 'us' } };
    await ctx.UserController.updatePreferences(req, res, () => {});
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.unitSystem, 'us');
    assert.deepStrictEqual(ctx.userUpdates[0].values, { unitSystem: 'us' });
    assert.deepStrictEqual(ctx.cacheDels, [7]);
    assert.strictEqual(req.user.unitSystem, 'us');
  });

  it('PUT null clears back to inherit and resolves to the server default', async () => {
    const res = makeRes();
    const req = { user: user('us'), body: { unitSystem: null } };
    await ctx.UserController.updatePreferences(req, res, () => {});
    assert.strictEqual(res.body.unitSystem, 'metric');
    assert.deepStrictEqual(ctx.userUpdates[0].values, { unitSystem: null });
  });

  it('PUT rejects an invalid value with 400 and writes nothing', async () => {
    const res = makeRes();
    await ctx.UserController.updatePreferences(
      { user: user(null), body: { unitSystem: 'imperial' } },
      res,
      () => {},
    );
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/unitSystem/.test(res.body.error));
    assert.strictEqual(ctx.userUpdates.length, 0);
  });

  it('PUT requires the key (no partial update)', async () => {
    const res = makeRes();
    await ctx.UserController.updatePreferences({ user: user(null), body: {} }, res, () => {});
    assert.strictEqual(res.statusCode, 400);
  });
});

describe('DEFAULT_UNIT_SYSTEM precedence', () => {
  it('us env + NULL user → us', async () => {
    const ctx = loadController('us');
    const res = makeRes();
    await ctx.UserController.getPreferences({ user: { id: 1, unitSystem: null } }, res, () => {});
    assert.strictEqual(res.body.unitSystem, 'us');
    assert.strictEqual(res.body.serverDefault, 'us');
    ctx.restore();
  });

  it('us env + explicit metric user → metric', async () => {
    const ctx = loadController('us');
    const res = makeRes();
    await ctx.UserController.getPreferences({ user: { id: 1, unitSystem: 'metric' } }, res, () => {});
    assert.strictEqual(res.body.unitSystem, 'metric');
    ctx.restore();
  });

  it('invalid env fails config load', () => {
    const previous = process.env.DEFAULT_UNIT_SYSTEM;
    process.env.DEFAULT_UNIT_SYSTEM = 'imperial';
    const configPath = require.resolve('../config/config');
    delete require.cache[configPath];
    try {
      assert.throws(() => require('../config/config'), /DEFAULT_UNIT_SYSTEM must be one of/);
    } finally {
      if (previous === undefined) delete process.env.DEFAULT_UNIT_SYSTEM;
      else process.env.DEFAULT_UNIT_SYSTEM = previous;
      delete require.cache[configPath];
    }
  });
});

describe('preferences are not global settings', () => {
  it('settingsUpdateSchema rejects unitSystem (front door is the Users endpoint)', () => {
    const { settingsUpdateSchema } = require('../lib/validators');
    const { error } = settingsUpdateSchema.validate({ unitSystem: 'us' });
    assert.ok(error, 'unitSystem must be unknown to the settings schema');
  });
});
