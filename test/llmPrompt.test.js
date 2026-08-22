const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeSummaryStats, resampleTelemetry, buildTelemetryCsv } = require('../lib/llmPrompt');

describe('computeSummaryStats', () => {
  it('computes min/max/mean/median for numeric fields', () => {
    const sample = [
      { engine_rpm: 1000, vehicle_speed: 50, values: {} },
      { engine_rpm: 2000, vehicle_speed: 60, values: {} },
      { engine_rpm: 3000, vehicle_speed: 70, values: {} },
    ];
    const stats = computeSummaryStats(sample, []);
    assert.strictEqual(stats.engine_rpm.min, 1000);
    assert.strictEqual(stats.engine_rpm.max, 3000);
    assert.strictEqual(stats.engine_rpm.mean, 2000);
    assert.strictEqual(stats.engine_rpm.median, 2000);
    assert.strictEqual(stats.engine_rpm.count, 3);
  });

  it('does NOT treat null values as 0', () => {
    const sample = [
      { engine_rpm: 1000, vehicle_speed: null, values: {} },
      { engine_rpm: 2000, vehicle_speed: null, values: {} },
      { engine_rpm: null, vehicle_speed: 60, values: {} },
    ];
    const stats = computeSummaryStats(sample, []);
    assert.strictEqual(stats.vehicle_speed.count, 1);
    assert.strictEqual(stats.vehicle_speed.mean, 60);
    assert.strictEqual(stats.engine_rpm.count, 2);
    assert.strictEqual(stats.engine_rpm.mean, 1500);
  });

  it('does NOT treat empty strings as 0', () => {
    const sample = [
      { engine_rpm: 1000, vehicle_speed: '', values: {} },
      { engine_rpm: 2000, vehicle_speed: 50, values: {} },
    ];
    const stats = computeSummaryStats(sample, []);
    assert.strictEqual(stats.vehicle_speed.count, 1);
    assert.strictEqual(stats.vehicle_speed.mean, 50);
  });

  it('computes combined fuel trim per-row, not per-array', () => {
    const sample = [
      { values: { k6: 2.5, k7: -3.0 } },
      { values: { k6: 1.0, k7: -2.0 } },
      { values: { k6: null, k7: -5.0 } },
    ];
    const stats = computeSummaryStats(sample, []);
    assert.ok(stats.total_fuel_trim);
    assert.strictEqual(stats.total_fuel_trim.count, 2);
    assert.strictEqual(stats.total_fuel_trim.min, -1.0);
    assert.strictEqual(stats.total_fuel_trim.max, -0.5);
  });

  it('omits combined fuel trim when k6/k7 are missing', () => {
    const sample = [
      { values: { kc: 1000 } },
    ];
    const stats = computeSummaryStats(sample, []);
    assert.strictEqual(stats.total_fuel_trim, undefined);
  });

  it('includes PID keys from values JSONB', () => {
    const sample = [
      { engine_rpm: 1000, values: { k5: 85, ke: 15 } },
    ];
    const stats = computeSummaryStats(sample, ['k5', 'ke']);
    assert.ok(stats.k5);
    assert.strictEqual(stats.k5.mean, 85);
    assert.ok(stats.ke);
    assert.strictEqual(stats.ke.mean, 15);
  });
});

describe('resampleTelemetry', () => {
  it('returns input unchanged when fewer than maxRows', () => {
    const input = [{ a: 1 }, { a: 2 }];
    assert.deepStrictEqual(resampleTelemetry(input, 80), input);
  });

  it('returns input unchanged when exactly maxRows', () => {
    const input = Array.from({ length: 80 }, (_, i) => ({ i }));
    assert.deepStrictEqual(resampleTelemetry(input, 80), input);
  });

  it('returns exactly maxRows samples from larger input', () => {
    const input = Array.from({ length: 200 }, (_, i) => ({ i }));
    const result = resampleTelemetry(input, 80);
    assert.strictEqual(result.length, 80);
    assert.strictEqual(result[0].i, 0);
    assert.strictEqual(result[79].i, 199);
  });

  it('handles single-element input', () => {
    const input = [{ a: 1 }];
    assert.deepStrictEqual(resampleTelemetry(input, 80), input);
  });
});

describe('buildTelemetryCsv', () => {
  it('returns (no telemetry data) for empty input', () => {
    assert.strictEqual(buildTelemetryCsv([], []), '(no telemetry data)');
  });

  it('produces CSV format, not Markdown', () => {
    const sample = [
      { timestamp: '2026-07-27T10:00:00Z', engine_rpm: 1000, vehicle_speed: 50, values: {} },
    ];
    const result = buildTelemetryCsv(sample, []);
    assert.ok(result.startsWith('Time,RPM,Speed'));
    assert.ok(!result.includes('|'));
    assert.ok(!result.includes('---'));
  });

  it('extracts HH:mm:ss from ISO timestamps', () => {
    const sample = [
      { timestamp: '2026-07-27T10:37:28Z', engine_rpm: 1000, vehicle_speed: 50, values: {} },
    ];
    const result = buildTelemetryCsv(sample, []);
    assert.ok(result.includes('10:37:28'));
  });

  it('extracts HH:mm:ss from space-separated timestamps', () => {
    const sample = [
      { timestamp: '2026-07-27 10:37:28', engine_rpm: 1000, vehicle_speed: 50, values: {} },
    ];
    const result = buildTelemetryCsv(sample, []);
    assert.ok(result.includes('10:37:28'));
  });
});
