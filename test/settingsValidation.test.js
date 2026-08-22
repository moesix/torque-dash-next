'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

/**
 * Mirrors the llmMaxTokens validation block in controllers/UserController.js
 * (updateSettings) so the bounds can be tested without a database or HTTP.
 * Returns { valid: true, value } on success (value coerced via Number, same
 * as the controller) or { valid: false } when out of range / not an integer.
 */
function validateMaxTokens(raw) {
  if (raw === undefined) return { valid: true, value: undefined };
  const t = Number(raw);
  if (!Number.isInteger(t) || t < 2048 || t > 32768) {
    return { valid: false };
  }
  return { valid: true, value: t };
}

describe('llmMaxTokens validation', () => {
  it('rejects values below 2048', () => {
    assert.strictEqual(validateMaxTokens(2047).valid, false);
    assert.strictEqual(validateMaxTokens(0).valid, false);
    assert.strictEqual(validateMaxTokens(-100).valid, false);
  });

  it('rejects values above 32768', () => {
    assert.strictEqual(validateMaxTokens(32769).valid, false);
    assert.strictEqual(validateMaxTokens(100000).valid, false);
  });

  it('rejects non-integers', () => {
    assert.strictEqual(validateMaxTokens(16384.5).valid, false);
    assert.strictEqual(validateMaxTokens('abc').valid, false);
    assert.strictEqual(validateMaxTokens(NaN).valid, false);
    assert.strictEqual(validateMaxTokens(null).valid, false);
  });

  it('accepts boundary values (2048, 32768)', () => {
    assert.deepStrictEqual(validateMaxTokens(2048), { valid: true, value: 2048 });
    assert.deepStrictEqual(validateMaxTokens(32768), { valid: true, value: 32768 });
  });

  it('accepts default value 16384', () => {
    assert.deepStrictEqual(validateMaxTokens(16384), { valid: true, value: 16384 });
  });

  it('coerces numeric strings like the controller Number() cast', () => {
    assert.deepStrictEqual(validateMaxTokens('16384'), { valid: true, value: 16384 });
    assert.strictEqual(validateMaxTokens('2047').valid, false);
  });

  it('treats undefined as omitted (no-op)', () => {
    assert.deepStrictEqual(validateMaxTokens(undefined), { valid: true, value: undefined });
  });
});

// ── Retention validation ──────────────────────────────────────────────
// Mirrors the retentionEnabled/retentionDays validation block in
// controllers/UserController.js (updateSettings) so the plan's HTTP-level
// cases can be tested without a database or HTTP (same pattern as
// validateMaxTokens above). Returns { valid: true } on success or
// { valid: false, error } with the exact controller error message.
function validateRetention(body) {
  if (body.retentionEnabled !== undefined) {
    if (typeof body.retentionEnabled !== 'boolean') {
      return { valid: false, error: 'retentionEnabled must be a boolean.' };
    }
  }
  if (body.retentionDays !== undefined) {
    if (typeof body.retentionDays !== 'number' || !Number.isInteger(body.retentionDays)) {
      return { valid: false, error: 'retentionDays must be an integer.' };
    }
    if (body.retentionDays < 90 || body.retentionDays > 365) {
      return { valid: false, error: 'retentionDays must be between 90 and 365.' };
    }
  }
  return { valid: true };
}

// Mirrors the getSettings/updateSettings response mapping so the response
// shape case can be asserted without booting the app: retentionEnabled must
// surface as a boolean and retentionDays as a number, defaulting to the
// migration/model defaults (false, 365) like the controller's ?? fallbacks.
function buildSettingsResponse(settings) {
  return {
    retentionEnabled: settings.retentionEnabled ?? false,
    retentionDays: settings.retentionDays ?? 365,
  };
}

describe('retention validation', () => {
  it('rejects non-boolean retentionEnabled', () => {
    const r = validateRetention({ retentionEnabled: 'yes' });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'retentionEnabled must be a boolean.');
  });

  it('rejects non-integer retentionDays', () => {
    const r = validateRetention({ retentionDays: 36.5 });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'retentionDays must be an integer.');
  });

  it('rejects retentionDays below 90', () => {
    const r = validateRetention({ retentionDays: 89 });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'retentionDays must be between 90 and 365.');
  });

  it('rejects retentionDays above 365', () => {
    const r = validateRetention({ retentionDays: 366 });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'retentionDays must be between 90 and 365.');
  });

  it('accepts a valid retentionDays value (180)', () => {
    assert.strictEqual(validateRetention({ retentionDays: 180 }).valid, true);
  });

  it('accepts boundary retentionDays values (90, 365)', () => {
    assert.strictEqual(validateRetention({ retentionDays: 90 }).valid, true);
    assert.strictEqual(validateRetention({ retentionDays: 365 }).valid, true);
  });

  it('rejects null retentionDays (typeof null is object, not number)', () => {
    const r = validateRetention({ retentionDays: null });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'retentionDays must be an integer.');
  });

  it('accepts combined payload (retentionEnabled false with valid retentionDays)', () => {
    const r = validateRetention({ retentionEnabled: false, retentionDays: 180 });
    assert.strictEqual(r.valid, true);
  });

  it('accepts boolean retentionEnabled true', () => {
    assert.strictEqual(validateRetention({ retentionEnabled: true }).valid, true);
  });

  it('settings response includes retentionEnabled (boolean) and retentionDays (number)', () => {
    const res = buildSettingsResponse({});
    assert.strictEqual(typeof res.retentionEnabled, 'boolean');
    assert.strictEqual(typeof res.retentionDays, 'number');
    const full = buildSettingsResponse({ retentionEnabled: true, retentionDays: 180 });
    assert.strictEqual(full.retentionEnabled, true);
    assert.strictEqual(full.retentionDays, 180);
  });
});
