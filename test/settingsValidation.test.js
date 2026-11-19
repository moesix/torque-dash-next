'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Pre-populate require.cache for ../models so the controller can load
// without connecting to a real database. `settingsState` backs the singleton
// row so updateSettings' re-fetch projection can be asserted.
let settingsState = {};
const mockModels = {
  Session: { findOne: async () => null, findAll: async () => [], count: async () => 0, update: async () => [0] },
  Log: { count: async () => 0, findAll: async () => [], destroy: async () => 0 },
  User: { findOne: async () => null },
  Vehicle: { findOne: async () => null },
  Settings: {
    getSingleton: async () => settingsState,
    upsert: async (data) => {
      Object.assign(settingsState, data);
      return settingsState;
    },
    invalidateCache: () => {},
  },
  sequelize: { transaction: async (fn) => fn({}), query: async () => [], fn: () => {}, col: () => {} },
  Sequelize: { Op: {} },
};
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: mockModels };

const {
  validateLlmThinkingMode,
  validateLlmMaxTokens,
  validateRetentionEnabled,
  validateRetentionDays,
  validateAnalysisRetentionDays,
  validateTileProvider,
  validateCartoApiKey,
  settingsUpdateSchema,
  MAX_CARTO_API_KEY_LENGTH,
} = require('../lib/validators');
const UserController = require('../controllers/UserController');
const { settingsView } = UserController;

// ── LLM thinking mode ──────────────────────────────────────────────

describe('validateLlmThinkingMode', () => {
  it('accepts true', () => {
    assert.deepStrictEqual(validateLlmThinkingMode(true), { ok: true });
  });

  it('accepts false', () => {
    assert.deepStrictEqual(validateLlmThinkingMode(false), { ok: true });
  });

  it('rejects non-boolean values', () => {
    const r = validateLlmThinkingMode('yes');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'llmThinkingMode must be a boolean.');
  });

  it('rejects null', () => {
    assert.strictEqual(validateLlmThinkingMode(null).ok, false);
  });

  it('rejects number', () => {
    assert.strictEqual(validateLlmThinkingMode(1).ok, false);
  });
});

// ── LLM max tokens ─────────────────────────────────────────────────

describe('validateLlmMaxTokens', () => {
  it('rejects values below 2048', () => {
    assert.strictEqual(validateLlmMaxTokens(2047).ok, false);
    assert.strictEqual(validateLlmMaxTokens(0).ok, false);
    assert.strictEqual(validateLlmMaxTokens(-100).ok, false);
  });

  it('rejects values above 32768', () => {
    assert.strictEqual(validateLlmMaxTokens(32769).ok, false);
    assert.strictEqual(validateLlmMaxTokens(100000).ok, false);
  });

  it('rejects non-integers', () => {
    assert.strictEqual(validateLlmMaxTokens(16384.5).ok, false);
    assert.strictEqual(validateLlmMaxTokens('abc').ok, false);
    assert.strictEqual(validateLlmMaxTokens(NaN).ok, false);
    assert.strictEqual(validateLlmMaxTokens(null).ok, false);
  });

  it('accepts boundary values (2048, 32768)', () => {
    assert.deepStrictEqual(validateLlmMaxTokens(2048), { ok: true, value: 2048 });
    assert.deepStrictEqual(validateLlmMaxTokens(32768), { ok: true, value: 32768 });
  });

  it('accepts default value 16384', () => {
    assert.deepStrictEqual(validateLlmMaxTokens(16384), { ok: true, value: 16384 });
  });

  it('coerces numeric strings like the controller Number() cast', () => {
    assert.deepStrictEqual(validateLlmMaxTokens('16384'), { ok: true, value: 16384 });
    assert.strictEqual(validateLlmMaxTokens('2047').ok, false);
  });
});

// ── Retention enabled ───────────────────────────────────────────────

describe('validateRetentionEnabled', () => {
  it('rejects non-boolean retentionEnabled', () => {
    const r = validateRetentionEnabled('yes');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'retentionEnabled must be a boolean.');
  });

  it('accepts boolean true', () => {
    assert.deepStrictEqual(validateRetentionEnabled(true), { ok: true });
  });

  it('accepts boolean false', () => {
    assert.deepStrictEqual(validateRetentionEnabled(false), { ok: true });
  });

  it('rejects null', () => {
    assert.strictEqual(validateRetentionEnabled(null).ok, false);
  });

  it('rejects number', () => {
    assert.strictEqual(validateRetentionEnabled(1).ok, false);
  });
});

// ── Retention days ──────────────────────────────────────────────────

describe('validateRetentionDays', () => {
  it('rejects non-integer retentionDays', () => {
    const r = validateRetentionDays(36.5);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'retentionDays must be an integer.');
  });

  it('rejects retentionDays below 90', () => {
    const r = validateRetentionDays(89);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'retentionDays must be between 90 and 365.');
  });

  it('rejects retentionDays above 365', () => {
    const r = validateRetentionDays(366);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'retentionDays must be between 90 and 365.');
  });

  it('accepts a valid retentionDays value (180)', () => {
    assert.deepStrictEqual(validateRetentionDays(180), { ok: true });
  });

  it('accepts boundary retentionDays values (90, 365)', () => {
    assert.deepStrictEqual(validateRetentionDays(90), { ok: true });
    assert.deepStrictEqual(validateRetentionDays(365), { ok: true });
  });

  it('rejects null retentionDays (typeof null is object, not number)', () => {
    const r = validateRetentionDays(null);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'retentionDays must be an integer.');
  });
});

// ── Analysis retention days ──────────────────────────────────────────

describe('validateAnalysisRetentionDays', () => {
  it('accepts null/undefined (prune job disabled)', () => {
    assert.deepStrictEqual(validateAnalysisRetentionDays(null), { ok: true });
    assert.deepStrictEqual(validateAnalysisRetentionDays(undefined), { ok: true });
  });

  it('rejects non-integer analysisRetentionDays', () => {
    const r = validateAnalysisRetentionDays(36.5);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'analysisRetentionDays must be an integer.');
  });

  it('rejects analysisRetentionDays below 90', () => {
    const r = validateAnalysisRetentionDays(89);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'analysisRetentionDays must be between 90 and 365.');
  });

  it('rejects analysisRetentionDays above 365', () => {
    const r = validateAnalysisRetentionDays(366);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'analysisRetentionDays must be between 90 and 365.');
  });

  it('accepts a valid analysisRetentionDays value (180)', () => {
    assert.deepStrictEqual(validateAnalysisRetentionDays(180), { ok: true });
  });

  it('accepts boundary analysisRetentionDays values (90, 365)', () => {
    assert.deepStrictEqual(validateAnalysisRetentionDays(90), { ok: true });
    assert.deepStrictEqual(validateAnalysisRetentionDays(365), { ok: true });
  });
});

// ── Map tile provider (basemap, migration 021) ────────────────────────

describe('validateTileProvider', () => {
  it('accepts the default keyless provider ("osm")', () => {
    assert.deepStrictEqual(validateTileProvider('osm'), { ok: true, value: 'osm' });
  });

  it('accepts the opt-in upgrade ("carto")', () => {
    assert.deepStrictEqual(validateTileProvider('carto'), { ok: true, value: 'carto' });
  });

  it('rejects an unknown provider with 400-style message naming the allowlist', () => {
    const r = validateTileProvider('osm-custom');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /osm, carto/);
  });

  it('rejects null (the DB column is NOT NULL)', () => {
    assert.strictEqual(validateTileProvider(null).ok, false);
  });

  it('rejects non-string values', () => {
    assert.strictEqual(validateTileProvider(1).ok, false);
    assert.strictEqual(validateTileProvider(true).ok, false);
    assert.strictEqual(validateTileProvider({}).ok, false);
  });

  it('accepts undefined as "field absent from this PUT"', () => {
    assert.deepStrictEqual(validateTileProvider(undefined), { ok: true });
  });
});

describe('validateCartoApiKey', () => {
  it('accepts a normal string key', () => {
    assert.deepStrictEqual(validateCartoApiKey('abcd1234'), { ok: true, value: 'abcd1234' });
  });

  it('trims surrounding whitespace (" " normalizes to "")', () => {
    assert.deepStrictEqual(validateCartoApiKey('  '), { ok: true, value: '' });
    assert.deepStrictEqual(validateCartoApiKey(' key '), { ok: true, value: 'key' });
  });

  it('allows an explicit empty string (stored as given, never rendered)', () => {
    assert.deepStrictEqual(validateCartoApiKey(''), { ok: true, value: '' });
  });

  it('rejects keys longer than the 255-character cap', () => {
    const r = validateCartoApiKey('k'.repeat(MAX_CARTO_API_KEY_LENGTH + 1));
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /at most 255 characters/);
  });

  it('accepts a key exactly at the 255-character cap (boundary)', () => {
    const long = 'k'.repeat(MAX_CARTO_API_KEY_LENGTH);
    assert.deepStrictEqual(validateCartoApiKey(long), { ok: true, value: long });
  });

  it('rejects null (only undefined means "absent"; clearing is the empty string)', () => {
    assert.strictEqual(validateCartoApiKey(null).ok, false);
  });

  it('rejects non-string values', () => {
    assert.strictEqual(validateCartoApiKey(42).ok, false);
    assert.strictEqual(validateCartoApiKey(['k']).ok, false);
  });
});

// ── Settings response shape (REAL settingsView from UserController) ─

describe('settings response shape (real settingsView)', () => {
  it('defaults to boolean retentionEnabled and number retentionDays', () => {
    const res = settingsView({});
    assert.strictEqual(typeof res.retentionEnabled, 'boolean');
    assert.strictEqual(typeof res.retentionDays, 'number');
    assert.strictEqual(res.retentionEnabled, false);
    assert.strictEqual(res.retentionDays, 365);
  });

  it('defaults analysisRetentionDays to null (prune job disabled)', () => {
    const res = settingsView({});
    assert.strictEqual(res.analysisRetentionDays, null);
  });

  it('passes through provided values', () => {
    const full = settingsView({ retentionEnabled: true, retentionDays: 180 });
    assert.strictEqual(full.retentionEnabled, true);
    assert.strictEqual(full.retentionDays, 180);
  });

  it('passes through analysisRetentionDays when set', () => {
    const full = settingsView({ analysisRetentionDays: 180 });
    assert.strictEqual(full.analysisRetentionDays, 180);
  });

  it('does not include retentionPolicyApplied (updateSettings-only extra)', () => {
    const res = settingsView({});
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(res, 'retentionPolicyApplied'),
      false
    );
  });
});

// ── Map basemap response shape (migration 021) ─────────────────────────

describe('settings response shape — map tile provider (real settingsView)', () => {
  it('defaults tileProvider to "osm" when the column is unset (pre-migration row)', () => {
    const res = settingsView({});
    assert.strictEqual(res.tileProvider, 'osm');
  });

  it('passes through tileProvider "carto"', () => {
    const res = settingsView({ tileProvider: 'carto' });
    assert.strictEqual(res.tileProvider, 'carto');
  });

  it('never exposes cartoApiKey while OSM is active', () => {
    const res = settingsView({ tileProvider: 'osm', cartoApiKey: 'leak-me' });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(res, 'cartoApiKey'),
      false,
      'cartoApiKey must be omitted entirely when tileProvider is osm'
    );
  });

  it('never exposes cartoApiKey when the provider is unset (defaults to osm)', () => {
    const res = settingsView({ cartoApiKey: 'leak-me' });
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(res, 'cartoApiKey'),
      false
    );
  });

  it('exposes the stored cartoApiKey when carto is the active provider', () => {
    const res = settingsView({ tileProvider: 'carto', cartoApiKey: 'k'.repeat(255) });
    assert.strictEqual(res.cartoApiKey, 'k'.repeat(255));
  });

  it('exposes tileProvider "carto" with an empty-string key (frontend declines to render it)', () => {
    const res = settingsView({ tileProvider: 'carto', cartoApiKey: '' });
    assert.strictEqual(res.tileProvider, 'carto');
    assert.strictEqual(res.cartoApiKey, '');
  });

  it('treats a null key under carto as absent-but-exposed empty string', () => {
    const res = settingsView({ tileProvider: 'carto', cartoApiKey: null });
    assert.strictEqual(res.cartoApiKey, '');
  });
});

// ── LLM endpoint URL validation (plan 030) ──────────────────────────
// Drives the REAL controller so the route's admin gate + validator +
// projection are exercised together (the HTTP-level counterparts live in
// adminGate.test.js).

describe('PUT /api/settings — llmEndpoint URL rejection', () => {
  function makeRes() {
    const calls = { statusCode: null, body: null };
    const res = {
      status(code) { calls.statusCode = code; return res; },
      json(obj) { calls.body = obj; return res; },
    };
    return { res, calls };
  }

  function makeReq(body) {
    // updateSettings is admin-gated; the gate itself is covered elsewhere.
    settingsState = {};
    return { user: { id: 1, isAdmin: true }, body };
  }

  it('rejects a URL carrying userinfo even when it parses', async () => {
    const { res, calls } = makeRes();
    await UserController.updateSettings(makeReq({ llmEndpoint: 'https://u:p@example.com/v1' }), res);
    assert.strictEqual(calls.statusCode, 400);
    assert.deepStrictEqual(calls.body, { error: 'Endpoint URL must not contain credentials.' });
  });

  it('rejects a username-only userinfo URL too', async () => {
    const { res, calls } = makeRes();
    await UserController.updateSettings(makeReq({ llmEndpoint: 'https://user@example.com/v1' }), res);
    assert.strictEqual(calls.statusCode, 400);
    assert.deepStrictEqual(calls.body, { error: 'Endpoint URL must not contain credentials.' });
  });

  it('rejects non-http(s) schemes', async () => {
    const { res, calls } = makeRes();
    await UserController.updateSettings(makeReq({ llmEndpoint: 'ftp://example.com' }), res);
    assert.strictEqual(calls.statusCode, 400);
    assert.deepStrictEqual(calls.body, { error: 'Endpoint URL must be http or https.' });
  });

  it('rejects values that do not parse as a URL', async () => {
    const { res, calls } = makeRes();
    await UserController.updateSettings(makeReq({ llmEndpoint: 'not a url' }), res);
    assert.strictEqual(calls.statusCode, 400);
    assert.deepStrictEqual(calls.body, { error: 'Invalid endpoint URL' });
  });

  it('accepts an https endpoint with a path', async () => {
    const { res, calls } = makeRes();
    await UserController.updateSettings(makeReq({ llmEndpoint: 'https://example.com/v1' }), res);
    assert.strictEqual(calls.statusCode, null, 'no error status was set');
    assert.strictEqual(calls.body.llmEndpoint, 'https://example.com/v1');
  });

  it('accepts a plain-http endpoint (self-hosted ollama) and null (clear)', async () => {
    const http = makeRes();
    await UserController.updateSettings(makeReq({ llmEndpoint: 'http://ollama.local:11434/v1' }), http.res);
    assert.strictEqual(http.calls.statusCode, null);
    assert.strictEqual(http.calls.body.llmEndpoint, 'http://ollama.local:11434/v1');

    const cleared = makeRes();
    await UserController.updateSettings(makeReq({ llmEndpoint: null }), cleared.res);
    assert.strictEqual(cleared.calls.statusCode, null);
    assert.strictEqual(cleared.calls.body.llmEndpoint, null);
  });
});

// ── llmModel acceptance (plan 032) ─────────────────────────────────
// null is an explicit clear: the settings card sends it when the provider
// changes so the new provider falls back to its default model.

describe('PUT /api/settings — llmModel null acceptance', () => {
  function makeRes() {
    const calls = { statusCode: null, body: null };
    const res = {
      status(code) { calls.statusCode = code; return res; },
      json(obj) { calls.body = obj; return res; },
    };
    return { res, calls };
  }

  function makeReq(body) {
    settingsState = {};
    return { user: { id: 1, isAdmin: true }, body };
  }

  it('accepts null, persists null, and returns null', async () => {
    const { res, calls } = makeRes();
    await UserController.updateSettings(makeReq({ llmModel: null }), res);
    assert.strictEqual(calls.statusCode, null, 'no error status was set');
    assert.strictEqual(settingsState.llmModel, null, 'persisted value must be null');
    assert.strictEqual(calls.body.llmModel, null);
  });

  it('still rejects a non-string model and an over-long string', async () => {
    const number = makeRes();
    await UserController.updateSettings(makeReq({ llmModel: 42 }), number.res);
    assert.strictEqual(number.calls.statusCode, 400);

    const long = makeRes();
    await UserController.updateSettings(makeReq({ llmModel: 'm'.repeat(201) }), long.res);
    assert.strictEqual(long.calls.statusCode, 400);
  });
});

// ── settingsUpdateSchema — the front door (plan 033) ────────────────
// The schema owns the accepted key list; the handler keeps only the special
// cases (URL parsing, encrypted key, env kill-switches). Every key the SPA
// sends must be listed, or the PUT becomes a 400.

describe('settingsUpdateSchema', () => {
  it('accepts every key the settings UI sends in one body', () => {
    const body = {
      disableRegistration: false,
      uploadApiToken: null,
      llmProvider: 'custom',
      llmModel: 'my-model',
      llmEndpoint: 'https://proxy.example.com/v1',
      llmThinkingMode: true,
      llmReasoningEffort: 'high',
      llmMaxTokens: 16384,
      timezoneOffset: 480,
      retentionEnabled: true,
      retentionDays: 180,
      analysisRetentionDays: null,
      tileProvider: 'carto',
      cartoApiKey: 'carto_key',
    };
    const { error } = settingsUpdateSchema.validate(body);
    assert.ifError(error);
  });

  it('accepts llmApiKey (AiProviderCard sends it only when typed)', () => {
    assert.ifError(settingsUpdateSchema.validate({ llmApiKey: 'sk-test' }).error);
    assert.ifError(settingsUpdateSchema.validate({ llmApiKey: null }).error);
  });

  it('accepts provider switch shapes (null provider/model/endpoint)', () => {
    assert.ifError(settingsUpdateSchema.validate({
      llmProvider: null, llmModel: null, llmEndpoint: null,
    }).error);
    assert.ifError(settingsUpdateSchema.validate({ llmProvider: 'openai', llmModel: null }).error);
  });

  it('rejects an unknown key instead of silently ignoring it', () => {
    const { error } = settingsUpdateSchema.validate({ notAField: true });
    assert.ok(error);
    assert.match(error.message, /notAField/);
  });

  it('keeps the old strict shapes', () => {
    // booleans were typeof-checked, not truthy
    assert.ok(settingsUpdateSchema.validate({ disableRegistration: 'true' }).error);
    assert.ok(settingsUpdateSchema.validate({ llmThinkingMode: 1 }).error);
    assert.ok(settingsUpdateSchema.validate({ retentionEnabled: 'false' }).error);
    // retention windows were strict integers
    assert.ok(settingsUpdateSchema.validate({ retentionDays: '180' }).error);
    assert.ok(settingsUpdateSchema.validate({ retentionDays: 89 }).error);
    assert.ok(settingsUpdateSchema.validate({ analysisRetentionDays: 366 }).error);
    // numeric-coerced fields (old Number() cast) still accept numeric strings
    assert.ifError(settingsUpdateSchema.validate({ llmMaxTokens: '16384' }).error);
    assert.ifError(settingsUpdateSchema.validate({ timezoneOffset: '480' }).error);
  });
});

describe('PUT /api/settings — schema front door', () => {
  function makeRes() {
    const calls = { statusCode: null, body: null };
    const res = {
      status(code) { calls.statusCode = code; return res; },
      json(obj) { calls.body = obj; return res; },
    };
    return { res, calls };
  }

  it('returns 400 for an unknown key and never writes', async () => {
    settingsState = {};
    const { res, calls } = makeRes();
    await UserController.updateSettings({ user: { id: 1, isAdmin: true }, body: { nope: 1 } }, res);
    assert.strictEqual(calls.statusCode, 400);
    assert.match(calls.body.error, /nope/);
    assert.deepStrictEqual(settingsState, {}, 'no upsert for a rejected body');
  });

  it('accepts a body of only UI-shaped keys', async () => {
    settingsState = {};
    const { res, calls } = makeRes();
    await UserController.updateSettings({
      user: { id: 1, isAdmin: true },
      body: { retentionDays: 180, timezoneOffset: 60, llmProvider: null },
    }, res);
    assert.strictEqual(calls.statusCode, null, JSON.stringify(calls.body));
    assert.strictEqual(settingsState.retentionDays, 180);
    assert.strictEqual(settingsState.timezoneOffset, 60);
  });
});

// ── Role projection (plan 030) ──────────────────────────────────────
describe('settingsView role projection', () => {
  const row = {
    llmProvider: 'custom',
    llmModel: 'operator-model',
    llmEndpoint: 'https://llm.internal/v1',
    llmApiKeyEnc: 'enc',
  };

  it('omits provider/model/endpoint for the default (two-argument) call', () => {
    const res = settingsView(row);
    for (const key of ['llmProvider', 'llmModel', 'llmEndpoint']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(res, key), false,
        `${key} must not appear in the non-admin projection`);
    }
    assert.strictEqual(res.hasLlmProvider, true);
    assert.strictEqual(res.hasLlmApiKey, true);
  });

  it('omits provider/model/endpoint for an explicit non-admin viewer', () => {
    const res = settingsView(row, {}, { isAdmin: false });
    assert.strictEqual(res.llmEndpoint, undefined);
    assert.strictEqual(res.llmModel, undefined);
    assert.strictEqual(res.llmProvider, undefined);
  });

  it('includes provider/model/endpoint for an admin viewer', () => {
    const res = settingsView(row, {}, { isAdmin: true });
    assert.strictEqual(res.llmProvider, 'custom');
    assert.strictEqual(res.llmModel, 'operator-model');
    assert.strictEqual(res.llmEndpoint, 'https://llm.internal/v1');
  });

  it('still spreads extras on top for both projections', () => {
    const nonAdmin = settingsView(row, { retentionPolicyApplied: true }, { isAdmin: false });
    assert.strictEqual(nonAdmin.retentionPolicyApplied, true);
    const admin = settingsView(row, { retentionPolicyApplied: true }, { isAdmin: true });
    assert.strictEqual(admin.retentionPolicyApplied, true);
  });
});
