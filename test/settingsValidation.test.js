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
