'use strict';

// Unit-system conversion matrix (plan 045). Mirrors
// apps/frontend/src/lib/__tests__/units.test.ts — both suites assert the JSON
// version so a factor edit cannot land on one runtime only.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  UNITS_VERSION,
  kindOf,
  convert,
  unitLabel,
  format,
  convertSeries,
  resolveUnitSystem,
} = require('../lib/units');

describe('units JSON', () => {
  it('has the shared version key', () => {
    assert.strictEqual(UNITS_VERSION, 1);
  });
});

describe('conversion matrix', () => {
  it('100 km/h → 62.137 mph', () => {
    assert.ok(Math.abs(convert(100, 'km/h', 'us') - 62.1371192237) < 1e-9);
  });

  it('100 °C → 212 °F', () => {
    assert.strictEqual(convert(100, '°C', 'us'), 212);
  });

  it('100 kPa → 14.5038 psi', () => {
    assert.ok(Math.abs(convert(100, 'kPa', 'us') - 14.50377377) < 1e-8);
  });

  it('10 m → 32.8084 ft', () => {
    assert.ok(Math.abs(convert(10, 'm', 'us') - 32.80839895) < 1e-8);
  });

  it('10 L → 2.6417 gal (US)', () => {
    assert.ok(Math.abs(convert(10, 'L', 'us') - 10 / 3.785411784) < 1e-12);
    assert.ok(Math.abs(convert(10, 'L', 'us') - 2.6417205236) < 1e-9);
  });

  it('10 L/100km → 23.52 MPG (US) and 28.25 MPG (UK)', () => {
    assert.ok(Math.abs(convert(10, 'L/100km', 'us') - 23.5214583) < 1e-6);
    assert.ok(Math.abs(convert(10, 'L/100km', 'uk') - 28.2480936) < 1e-6);
  });

  it('1 gal (US) → 3.7854 L', () => {
    assert.ok(Math.abs(convert(1, 'gal (US)', 'metric') - 3.785411784) < 1e-12);
  });

  it('1 gal (UK) → 4.5461 L', () => {
    assert.ok(Math.abs(convert(1, 'gal (UK)', 'metric') - 4.54609) < 1e-12);
  });

  it('is idempotent when the source already matches the target', () => {
    assert.strictEqual(convert(100, 'mph', 'us'), 100);
    assert.strictEqual(convert(100, 'km/h', 'metric'), 100);
    assert.strictEqual(convert(90, '°C', 'uk'), 90);
  });

  it('passes unknown units through untouched', () => {
    assert.strictEqual(convert(1234, 'rpm', 'us'), 1234);
    assert.strictEqual(convert(14.7, 'V', 'us'), 14.7);
    assert.strictEqual(convert(12.5, ':1', 'us'), 12.5);
    assert.strictEqual(convert(100, 'furlongs', 'us'), 100);
  });

  it('never treats a bare ° as temperature', () => {
    assert.strictEqual(kindOf('°'), 'none');
    assert.strictEqual(kindOf('rpm'), 'none');
    assert.strictEqual(kindOf('g'), 'none');
    assert.strictEqual(kindOf('g/s'), 'none');
    assert.strictEqual(kindOf('%'), 'none');
    assert.strictEqual(convert(32, '°', 'us'), 32);
  });

  it('returns null for a zero/negative economy value', () => {
    assert.strictEqual(convert(0, 'L/100km', 'us'), null);
    assert.strictEqual(convert(-3, 'L/100km', 'us'), null);
    assert.strictEqual(convert(0, 'MPG (US)', 'metric'), null);
  });

  it('handles bar as a pressure source (×100 kPa first)', () => {
    assert.ok(Math.abs(convert(2, 'bar', 'us') - 200 * 0.1450377377) < 1e-9);
  });

  it('converts fuel flow cc/min → gal/h (US)', () => {
    assert.ok(Math.abs(convert(1000, 'cc/min', 'us') - (60 / 3.785411784)) < 1e-12);
    assert.strictEqual(convert(1000, 'cc/min', 'metric'), 1000);
  });
});

describe('labels and formatting', () => {
  it('labels the target unit', () => {
    assert.strictEqual(unitLabel('km/h', 'us'), 'mph');
    assert.strictEqual(unitLabel('°C', 'us'), '°F');
    assert.strictEqual(unitLabel('kPa', 'us'), 'psi');
    assert.strictEqual(unitLabel('L/100km', 'uk'), 'MPG (UK)');
    assert.strictEqual(unitLabel('rpm', 'us'), '');
  });

  it('formats with per-kind precision', () => {
    assert.deepStrictEqual(format(100, 'km/h', 'us'), { text: '62 mph', unit: 'mph', value: 62 });
    assert.deepStrictEqual(format(90, '°C', 'us'), { text: '194 °F', unit: '°F', value: 194 });
    assert.deepStrictEqual(format(240, 'kPa', 'us'), { text: '35 psi', unit: 'psi', value: 35 });
    assert.deepStrictEqual(format(null, 'km/h', 'us'), { text: '—', unit: 'mph', value: null });
  });

  it('rounds half away from zero', () => {
    assert.strictEqual(format(100.5, 'km/h', 'metric').value, 101);
    assert.strictEqual(format(-0.5, 'kPa', 'metric').value, -1);
  });

  it('converts a series preserving timestamps and nulls', () => {
    assert.deepStrictEqual(
      convertSeries([[0, 100], [1, null]], 'km/h', 'metric'),
      [[0, 100], [1, null]],
    );
  });
});

describe('resolveUnitSystem precedence', () => {
  it('user value wins over the server default', () => {
    assert.strictEqual(resolveUnitSystem('uk', 'us'), 'uk');
  });
  it('NULL user inherits the server default', () => {
    assert.strictEqual(resolveUnitSystem(null, 'us'), 'us');
  });
  it('falls back to metric', () => {
    assert.strictEqual(resolveUnitSystem(null, undefined), 'metric');
    assert.strictEqual(resolveUnitSystem('bogus', 'bogus'), 'metric');
  });
  it('normalizes case and surrounding whitespace on both arguments', () => {
    assert.strictEqual(resolveUnitSystem(null, 'US'), 'us');
    assert.strictEqual(resolveUnitSystem(' UK ', 'metric'), 'uk');
    assert.strictEqual(resolveUnitSystem('bogus', 'US'), 'us');
    assert.strictEqual(resolveUnitSystem('bogus', 'bogus'), 'metric');
  });
});
