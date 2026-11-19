'use strict';

// Pure CSV-export helpers (lib/csvExport.js, extracted from SessionController
// in plans/017). No model imports and no DATABASE_URL needed — these tests
// were moved verbatim from test/settingsValidation.test.js, which previously
// reached them through the controller's re-exports.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { formatDuration, sanitizeFilename, csvEscape } = require('../lib/csvExport');

// ── formatDuration ─────────────────────────────────────────────────

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

// ── sanitizeFilename ───────────────────────────────────────────────

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

// ── csvEscape ──────────────────────────────────────────────────────

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

// ── buildCsvHeader (plan 045) ──────────────────────────────────────

const { buildCsvHeader } = require('../lib/csvExport');

describe('buildCsvHeader', () => {
  it('metric declares canonical units', () => {
    assert.deepStrictEqual(buildCsvHeader(['kc', 'k5', 'zzz'], 'metric'), [
      'timestamp',
      'lat (deg)',
      'lon (deg)',
      'engine_rpm',
      'vehicle_speed (km/h)',
      'kc',
      'k5 (°C)',
      'zzz',
    ]);
  });

  it('US converts the labels and keeps unknown PIDs bare', () => {
    assert.deepStrictEqual(buildCsvHeader(['kc', 'k5', 'kff1278', 'zzz'], 'us'), [
      'timestamp',
      'lat (deg)',
      'lon (deg)',
      'engine_rpm',
      'vehicle_speed (mph)',
      'kc',
      'k5 (°F)',
      'kff1278 (psi)',
      'zzz',
    ]);
  });

  it('UK labels', () => {
    const header = buildCsvHeader(['k5'], 'uk');
    assert.strictEqual(header[4], 'vehicle_speed (mph)');
    assert.strictEqual(header[5], 'k5 (°C)');
  });
});
