import { describe, it, expect } from 'vitest';
import { coerceScalar, getAvailableSeries, computeStats, findNearestFrameIndex } from '../pidDecode';

describe('coerceScalar', () => {
    it('returns null for null/undefined', () => {
        expect(coerceScalar(null)).toBeNull();
        expect(coerceScalar(undefined)).toBeNull();
    });
    it('parses numeric strings', () => {
        expect(coerceScalar('42')).toBe(42);
        expect(coerceScalar('3.14')).toBe(3.14);
    });
    it('returns null for non-numeric strings', () => {
        expect(coerceScalar('abc')).toBeNull();
    });
    it('handles zero correctly', () => {
        expect(coerceScalar(0)).toBe(0);
        expect(coerceScalar('0')).toBe(0);
    });
    it('handles arrays by taking first element', () => {
        expect(coerceScalar([42, 43])).toBe(42);
    });
    it('handles NaN numbers', () => {
        expect(coerceScalar(NaN)).toBeNull();
    });
    it('handles negative numbers', () => {
        expect(coerceScalar(-5.5)).toBe(-5.5);
    });
});

describe('getAvailableSeries', () => {
    it('returns only column sources for empty frames', () => {
        const series = getAvailableSeries([]);
        expect(series).toHaveLength(2);
        expect(series.map((s) => s.pid)).toEqual(['engineRpm', 'vehicleSpeed']);
    });
    it('always includes engineRpm and vehicleSpeed column sources', () => {
        const frames = [
            {
                timestamp: '2026-01-01T00:00:00Z',
                lon: null,
                lat: null,
                values: {},
                engineRpm: 1500,
                vehicleSpeed: 60,
            },
        ];
        const series = getAvailableSeries(frames);
        const pids = series.map((s) => s.pid);
        expect(pids).toContain('engineRpm');
        expect(pids).toContain('vehicleSpeed');
    });
    it('discovers PIDs from values bag', () => {
        const frames = [
            {
                timestamp: '2026-01-01T00:00:00Z',
                lon: null,
                lat: null,
                values: { kc: '1500', kd: '60' },
                engineRpm: 1500,
                vehicleSpeed: 60,
            },
        ];
        const series = getAvailableSeries(frames);
        const pids = series.map((s) => s.pid);
        expect(pids).toContain('kc');
        expect(pids).toContain('kd');
    });
    it('deduplicates across frames', () => {
        const frames = [
            {
                timestamp: '2026-01-01T00:00:00Z',
                lon: null,
                lat: null,
                values: { kc: '1500' },
                engineRpm: 1500,
                vehicleSpeed: 60,
            },
            {
                timestamp: '2026-01-01T00:00:01Z',
                lon: null,
                lat: null,
                values: { kc: '1600' },
                engineRpm: 1600,
                vehicleSpeed: 65,
            },
        ];
        const series = getAvailableSeries(frames);
        const kcSeries = series.filter((s) => s.pid === 'kc');
        expect(kcSeries).toHaveLength(1);
    });
    it('uses fallback map for known PIDs', () => {
        const frames = [
            {
                timestamp: '2026-01-01T00:00:00Z',
                lon: null,
                lat: null,
                values: { kc: '1500' },
                engineRpm: 1500,
                vehicleSpeed: 60,
            },
        ];
        const series = getAvailableSeries(frames);
        const kc = series.find((s) => s.pid === 'kc');
        expect(kc).toBeDefined();
        expect(kc!.full).toBe('Engine RPM');
        expect(kc!.unit).toBe('rpm');
    });
    it('returns results sorted by full name', () => {
        const frames = [
            {
                timestamp: '2026-01-01T00:00:00Z',
                lon: null,
                lat: null,
                values: { kd: '60', kc: '1500' },
                engineRpm: 1500,
                vehicleSpeed: 60,
            },
        ];
        const series = getAvailableSeries(frames);
        const fullNames = series.map((s) => s.full);
        const sorted = [...fullNames].sort((a, b) => a.localeCompare(b));
        expect(fullNames).toEqual(sorted);
    });
});

describe('computeStats', () => {
    it('returns null for empty data', () => {
        expect(computeStats([])).toBeNull();
    });
    it('computes min, max, avg, last', () => {
        const data: [number, number | null][] = [
            [1000, 10],
            [2000, 20],
            [3000, 30],
        ];
        const stats = computeStats(data);
        expect(stats).not.toBeNull();
        expect(stats!.min).toBe(10);
        expect(stats!.max).toBe(30);
        expect(stats!.avg).toBe(20);
        expect(stats!.last).toBe(30);
    });
    it('ignores null values', () => {
        const data: [number, number | null][] = [
            [1000, 10],
            [2000, null],
            [3000, 30],
        ];
        const stats = computeStats(data);
        expect(stats).not.toBeNull();
        expect(stats!.min).toBe(10);
        expect(stats!.max).toBe(30);
        expect(stats!.avg).toBe(20);
    });
    it('returns null when all values are null', () => {
        const data: [number, number | null][] = [
            [1000, null],
            [2000, null],
        ];
        expect(computeStats(data)).toBeNull();
    });
});

describe('findNearestFrameIndex', () => {
    it('returns the EARLIER index on an exact midpoint tie', () => {
        // t = 5000 sits exactly between 0 and 10000: earlier (0) must win.
        expect(findNearestFrameIndex([0, 10000, 20000], 5000)).toBe(0);
        expect(findNearestFrameIndex([0, 10000, 20000], 15000)).toBe(1);
    });
    it('returns 0 when t precedes all timestamps', () => {
        expect(findNearestFrameIndex([1000, 2000, 3000], 0)).toBe(0);
    });
    it('returns the last index when t follows all timestamps', () => {
        expect(findNearestFrameIndex([1000, 2000, 3000], 5000)).toBe(2);
    });
    it('returns -1 for an empty array', () => {
        expect(findNearestFrameIndex([], 1000)).toBe(-1);
    });
    it('returns 0 for a single element', () => {
        expect(findNearestFrameIndex([1000], 999)).toBe(0);
        expect(findNearestFrameIndex([1000], 1000)).toBe(0);
        expect(findNearestFrameIndex([1000], 1001)).toBe(0);
    });
    it('returns an exact timestamp hit', () => {
        expect(findNearestFrameIndex([0, 10000, 20000], 10000)).toBe(1);
    });
    it('returns the closer non-tie neighbour', () => {
        expect(findNearestFrameIndex([0, 10000, 20000], 16000)).toBe(2);
        expect(findNearestFrameIndex([0, 10000, 20000], 4000)).toBe(0);
    });
});
