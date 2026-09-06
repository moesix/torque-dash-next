'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Pre-populate require.cache for ../models so the controller can load
// without connecting to a real database.
const mockModels = {
  Session: { findOne: async () => null, findAll: async () => [], count: async () => 0, update: async () => [0] },
  Log: { count: async () => 0, findAll: async () => [], destroy: async () => 0 },
  User: { findOne: async () => null },
  Vehicle: { findOne: async () => null },
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
} = require('../lib/validators');
const {
  formatDuration,
  sanitizeFilename,
  csvEscape,
} = require('../controllers/SessionController');
const { settingsView } = require('../controllers/UserController');

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

// ── formatDuration (imported from real SessionController) ───────────

describe('formatDuration', () => {
  it('returns null when either bound is missing', () => {
    assert.strictEqual(formatDuration(null, '2026-01-01'), null);
    assert.strictEqual(formatDuration('2026-01-01', null), null);
    assert.strictEqual(formatDuration(undefined, undefined), null);
  });

  it('returns null for negative duration', () => {
    assert.strictEqual(formatDuration('2026-01-10', '2026-01-01'), null);
  });

  it('formats seconds only', () => {
    const r = formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:00:45Z');
    assert.strictEqual(r, '45s');
  });

  it('formats hours, minutes, seconds', () => {
    const r = formatDuration('2026-01-01T00:00:00Z', '2026-01-01T01:02:03Z');
    assert.strictEqual(r, '1h 2m 3s');
  });

  it('formats days, hours, minutes, seconds', () => {
    const r = formatDuration('2026-01-01T00:00:00Z', '2026-01-04T01:02:03Z');
    assert.strictEqual(r, '3d 1h 2m 3s');
  });
});

// ── sanitizeFilename (imported from real SessionController) ─────────

describe('sanitizeFilename', () => {
  it('replaces spaces with hyphens', () => {
    assert.strictEqual(sanitizeFilename('hello world'), 'hello-world');
  });

  it('strips path-dangerous characters', () => {
    assert.strictEqual(sanitizeFilename('a/b\\c:d'), 'abcd');
  });

  it('caps at 100 characters', () => {
    const long = 'x'.repeat(200);
    assert.strictEqual(sanitizeFilename(long).length, 100);
  });

  it('returns "session" for empty string', () => {
    assert.strictEqual(sanitizeFilename(''), 'session');
  });
});

// ── csvEscape (imported from real SessionController) ────────────────

describe('csvEscape', () => {
  it('returns empty string for null/undefined', () => {
    assert.strictEqual(csvEscape(null), '');
    assert.strictEqual(csvEscape(undefined), '');
  });

  it('passes through simple strings unchanged', () => {
    assert.strictEqual(csvEscape('hello'), 'hello');
  });

  it('wraps values containing commas in double quotes', () => {
    assert.strictEqual(csvEscape('a,b'), '"a,b"');
  });

  it('escapes embedded double quotes', () => {
    assert.strictEqual(csvEscape('a"b'), '"a""b"');
  });

  it('prefixes formula-injection chars with single quote', () => {
    assert.strictEqual(csvEscape('=1+1'), "'=1+1");
    assert.strictEqual(csvEscape('+cmd'), "'+cmd");
    assert.strictEqual(csvEscape('-cmd'), "'-cmd");
    assert.strictEqual(csvEscape('@cmd'), "'@cmd");
    assert.strictEqual(csvEscape('|cmd'), "'|cmd");
  });

  it('handles numeric values', () => {
    assert.strictEqual(csvEscape(42), '42');
  });
});
