import { describe, it, expect } from 'vitest';
import {
  UNITS_VERSION,
  kindOf,
  convert,
  unitLabel,
  format,
  convertSeries,
  roundTo,
} from '@/lib/units';

// Same matrix as test/units.test.js (backend). Both assert the JSON version
// so a factor edit cannot land on one runtime only.

describe('units JSON', () => {
  it('has the shared version key', () => {
    expect(UNITS_VERSION).toBe(1);
  });
});

describe('conversion matrix', () => {
  it('100 km/h → 62.137 mph', () => {
    expect(convert(100, 'km/h', 'us')).toBeCloseTo(62.1371192237, 9);
  });

  it('100 °C → 212 °F', () => {
    expect(convert(100, '°C', 'us')).toBe(212);
  });

  it('100 kPa → 14.5038 psi', () => {
    expect(convert(100, 'kPa', 'us')).toBeCloseTo(14.50377377, 8);
  });

  it('10 m → 32.8084 ft', () => {
    expect(convert(10, 'm', 'us')).toBeCloseTo(32.80839895, 8);
  });

  it('10 L → 2.6417 gal (US)', () => {
    expect(convert(10, 'L', 'us')).toBeCloseTo(2.6417205236, 9);
  });

  it('10 L/100km → 23.52 MPG (US) and 28.25 MPG (UK)', () => {
    expect(convert(10, 'L/100km', 'us')).toBeCloseTo(23.5214583, 6);
    expect(convert(10, 'L/100km', 'uk')).toBeCloseTo(28.2480936, 6);
  });

  it('1 gal (US) → 3.7854 L and 1 gal (UK) → 4.5461 L', () => {
    expect(convert(1, 'gal (US)', 'metric')).toBeCloseTo(3.785411784, 12);
    expect(convert(1, 'gal (UK)', 'metric')).toBeCloseTo(4.54609, 12);
  });

  it('is idempotent when the source already matches the target', () => {
    expect(convert(100, 'mph', 'us')).toBe(100);
    expect(convert(100, 'km/h', 'metric')).toBe(100);
    expect(convert(90, '°C', 'uk')).toBe(90);
  });

  it('passes unknown units through untouched', () => {
    expect(convert(1234, 'rpm', 'us')).toBe(1234);
    expect(convert(14.7, 'V', 'us')).toBe(14.7);
    expect(convert(12.5, ':1', 'us')).toBe(12.5);
    expect(convert(100, 'furlongs', 'us')).toBe(100);
  });

  it('never treats a bare ° as temperature', () => {
    expect(kindOf('°')).toBe('none');
    expect(kindOf('rpm')).toBe('none');
    expect(kindOf('g')).toBe('none');
    expect(kindOf('g/s')).toBe('none');
    expect(kindOf('%')).toBe('none');
    expect(convert(32, '°', 'us')).toBe(32);
  });

  it('returns null for a zero/negative economy value', () => {
    expect(convert(0, 'L/100km', 'us')).toBeNull();
    expect(convert(-3, 'L/100km', 'us')).toBeNull();
    expect(convert(0, 'MPG (US)', 'metric')).toBeNull();
  });

  it('handles bar as a pressure source', () => {
    expect(convert(2, 'bar', 'us')).toBeCloseTo(200 * 0.1450377377, 9);
  });

  it('converts fuel flow cc/min → gal/h (US)', () => {
    expect(convert(1000, 'cc/min', 'us')).toBeCloseTo(60 / 3.785411784, 12);
    expect(convert(1000, 'cc/min', 'metric')).toBe(1000);
  });
});

describe('labels and formatting', () => {
  it('labels the target unit', () => {
    expect(unitLabel('km/h', 'us')).toBe('mph');
    expect(unitLabel('°C', 'us')).toBe('°F');
    expect(unitLabel('kPa', 'us')).toBe('psi');
    expect(unitLabel('L/100km', 'uk')).toBe('MPG (UK)');
    expect(unitLabel('rpm', 'us')).toBe('');
  });

  it('formats with per-kind precision', () => {
    expect(format(100, 'km/h', 'us')).toEqual({ text: '62 mph', unit: 'mph', value: 62 });
    expect(format(90, '°C', 'us')).toEqual({ text: '194 °F', unit: '°F', value: 194 });
    expect(format(240, 'kPa', 'us')).toEqual({ text: '35 psi', unit: 'psi', value: 35 });
    expect(format(null, 'km/h', 'us')).toEqual({ text: '—', unit: 'mph', value: null });
  });

  it('rounds half away from zero', () => {
    expect(roundTo(100.5, 0)).toBe(101);
    expect(roundTo(-0.5, 0)).toBe(-1);
  });

  it('converts a series preserving timestamps and nulls', () => {
    expect(convertSeries([[0, 100], [1, null]], 'km/h', 'metric')).toEqual([
      [0, 100],
      [1, null],
    ]);
  });
});
