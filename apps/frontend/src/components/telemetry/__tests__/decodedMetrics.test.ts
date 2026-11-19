import { describe, it, expect } from 'vitest';
import type { TelemetryFrame } from '@/lib/types';
import {
  getAvailableSeries,
  getSeriesData,
  getSeriesStats,
  computeStats,
  precomputeEpochs,
} from '@/lib/pidDecode';

/**
 * Load-bearing equivalence test for the plan 037 stats fold:
 * `getSeriesStats` must be numerically identical to
 * `computeStats(getSeriesData(...))` for every source kind.
 *
 * The fixture deliberately exercises Torque's value quirks — numbers,
 * numeric strings, label arrays (k0c), NaN, null, empty arrays, a missing
 * key on some frames — so a divergence in value extraction fails here.
 */

const T0 = Date.parse('2026-11-18T10:00:00.000Z');

function frame(i: number, values: Record<string, unknown>): TelemetryFrame {
  return {
    timestamp: new Date(T0 + i * 1000).toISOString(),
    lon: null,
    lat: null,
    values,
    // Column sources: also exercise number | string | null | NaN.
    engineRpm: i % 7 === 0 ? null : i % 11 === 0 ? 1750.5 : 800 + (i % 60),
    vehicleSpeed: i % 5 === 0 ? null : (i * 1.5) % 130,
  };
}

const frames: TelemetryFrame[] = Array.from({ length: 500 }, (_, i) => {
  const values: Record<string, unknown> = {
    // kc: numeric and numeric-string mix + occasional hole
    ...(i % 9 === 0 ? {} : { kc: i % 4 === 0 ? String(700 + i) : 700 + i }),
    // k5: string values with units, plus nulls
    k5: i % 6 === 0 ? null : `${80 + (i % 40)}.5`,
    // k0c: Torque label array quirk
    k0c: i % 3 === 0 ? ['ECU(7E9): Engine RPM', 'Engine RPM'] : [String(1000 + i)],
    // kff1005: non-numeric junk every 13 frames
    kff1005: i % 13 === 0 ? 'n/a' : -1.234 + i * 0.0001,
    // k6/k7: trims with empty arrays and NaN
    k6: i % 8 === 0 ? [] : i % 17 === 0 ? NaN : 2.5,
    k7: i % 10 === 0 ? null : '-1.25',
    // metadata keys — must never become series
    userFullNameff1005: ['GPS Longitude'],
    userUnitff1005: ['deg'],
  };
  return frame(i, values);
});

const epochs = precomputeEpochs(frames);
const available = getAvailableSeries(frames);

function reduced(data: [number, number | null][]) {
  const stats = computeStats(data);
  if (!stats) return null;
  let count = 0;
  for (const [, v] of data) if (v !== null) count++;
  return { ...stats, count };
}

describe('getSeriesStats equivalence with computeStats(getSeriesData(...))', () => {
  it('has fixtures for every source kind', () => {
    expect(available.some((s) => s.source === 'column')).toBe(true);
    expect(available.some((s) => s.source === 'pid')).toBe(true);
    // The array-valued / junk-valued PIDs are actually present in the list.
    expect(available.map((s) => s.pid)).toEqual(
      expect.arrayContaining(['engineRpm', 'vehicleSpeed', 'kc', 'k5', 'k0c', 'kff1005', 'k6', 'k7']),
    );
  });

  it.each(available.map((s) => [s.pid, s] as const))(
    '%s matches the array-reduced stats',
    (_pid, src) => {
      const folded = getSeriesStats(frames, src, epochs);
      const expected = reduced(getSeriesData(frames, src, epochs));

      if (expected === null) {
        expect(folded).toBeNull();
        return;
      }
      expect(folded).not.toBeNull();
      expect(folded!.count).toBe(expected.count);
      expect(folded!.min).toBeCloseTo(expected.min, 10);
      expect(folded!.max).toBeCloseTo(expected.max, 10);
      expect(folded!.avg).toBeCloseTo(expected.avg, 10);
      expect(folded!.last).toBeCloseTo(expected.last as number, 10);
    },
  );

  it('returns null exactly when the series has no values', () => {
    const empty: TelemetryFrame[] = [
      { timestamp: new Date(T0).toISOString(), lon: null, lat: null, values: { kc: null }, engineRpm: null, vehicleSpeed: null },
    ];
    const e = precomputeEpochs(empty);
    for (const src of getAvailableSeries(empty)) {
      const data = getSeriesData(empty, src, e);
      expect(computeStats(data)).toBeNull();
      expect(getSeriesStats(empty, src, e)).toBeNull();
      expect(data.every(([, v]) => v === null)).toBe(true);
    }
  });

  it('rejects epochs from a different frames array (same contract as getSeriesData)', () => {
    const src = available[0];
    expect(() => getSeriesStats(frames, src, [1, 2, 3])).toThrow('epochs length mismatch');
  });
});
