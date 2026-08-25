'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Extraction helpers (same logic as scripts/checkMirrors.js) ─────────

function extractMap(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const match = new RegExp(`${varName}\\s*[^=]*?=\\s*\\{([\\s\\S]*?)\\};`, 'm').exec(src);
  if (!match) return null;
  const entries = {};
  const entryRe = /(\w+)\s*:\s*\{([^}]+)\}/g;
  let m;
  while ((m = entryRe.exec(match[1]))) {
    const key = m[1];
    const fields = {};
    const fieldRe = /(\w+)\s*:\s*'([^']*)'/g;
    let f;
    while ((f = fieldRe.exec(m[2]))) {
      fields[f[1]] = f[2];
    }
    entries[key] = fields;
  }
  return entries;
}

// Field name mapping: backend uses fullName/shortName, frontend uses full/short
const FIELD_MAP = { fullName: 'full', shortName: 'short' };

const BACKEND_PATH = path.join(__dirname, '..', 'lib', 'pidRegistry.js');
const FRONTEND_PATH = path.join(__dirname, '..', 'apps', 'frontend', 'src', 'lib', 'pidDecode.ts');

const backendPids = extractMap(BACKEND_PATH, 'PID_REGISTRY');
const frontendPids = extractMap(FRONTEND_PATH, 'FALLBACK_MAP');

describe('PID registry parity', () => {
  test('both maps extract successfully', () => {
    assert.ok(backendPids, 'backend PID_REGISTRY should be extractable');
    assert.ok(frontendPids, 'frontend FALLBACK_MAP should be extractable');
  });

  test('key sets are identical', () => {
    const backendKeys = Object.keys(backendPids).sort();
    const frontendKeys = Object.keys(frontendPids).sort();

    const inBackendOnly = backendKeys.filter((k) => !frontendPids[k]);
    const inFrontendOnly = frontendKeys.filter((k) => !backendPids[k]);

    assert.deepStrictEqual(
      inBackendOnly,
      [],
      `PIDs in backend but not frontend: ${inBackendOnly.join(', ')}`,
    );
    assert.deepStrictEqual(
      inFrontendOnly,
      [],
      `PIDs in frontend but not backend: ${inFrontendOnly.join(', ')}`,
    );
    assert.strictEqual(backendKeys.length, frontendKeys.length, 'key count mismatch');
  });

  test('all field values match across registries', () => {
    const mismatches = [];

    for (const [key, fields] of Object.entries(backendPids)) {
      const ff = frontendPids[key];
      if (!ff) continue;

      for (const [field, value] of Object.entries(fields)) {
        const frontendField = FIELD_MAP[field] || field;
        if (ff[frontendField] !== value) {
          mismatches.push(`${key}.${field}: backend="${value}" frontend="${ff[frontendField]}"`);
        }
      }
    }

    assert.deepStrictEqual(mismatches, [], `Field mismatches:\n  ${mismatches.join('\n  ')}`);
  });

  test('kff1005 is GPS Longitude (not Fuel Trim)', () => {
    assert.strictEqual(backendPids.kff1005.fullName, 'GPS Longitude');
    assert.strictEqual(backendPids.kff1005.shortName, 'Lon');
    assert.strictEqual(backendPids.kff1005.unit, '°');

    assert.strictEqual(frontendPids.kff1005.full, 'GPS Longitude');
    assert.strictEqual(frontendPids.kff1005.short, 'Lon');
    assert.strictEqual(frontendPids.kff1005.unit, '°');
  });

  test('kff1006 is GPS Latitude (not Fuel Trim)', () => {
    assert.strictEqual(backendPids.kff1006.fullName, 'GPS Latitude');
    assert.strictEqual(backendPids.kff1006.shortName, 'Lat');
    assert.strictEqual(backendPids.kff1006.unit, '°');

    assert.strictEqual(frontendPids.kff1006.full, 'GPS Latitude');
    assert.strictEqual(frontendPids.kff1006.short, 'Lat');
    assert.strictEqual(frontendPids.kff1006.unit, '°');
  });
});
