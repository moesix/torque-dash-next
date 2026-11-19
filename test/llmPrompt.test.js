const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeSummaryStats, resampleTelemetry, buildTelemetryCsv, buildAnalysisPrompt, buildContext } = require('../lib/llmPrompt');

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

describe('buildTelemetryCsv chronological ordering', () => {
  it('emits a monotonic Time column for a mixed-batch sample once sorted chronologically', () => {
    // The controller's large-session sample mixes an ASC head (first rows), an
    // id-order middle, and a DESC tail (last rows fetched newest-first) — the raw
    // assembly renders that tail newest-first in the prompt CSV. The controller
    // now sorts the assembled sample before building the prompt; this seam test
    // locks in the resulting guarantee at the CSV boundary: a chronologically
    // sorted sample yields a non-decreasing Time column even when
    // resampleTelemetry index-stepping engages (>maxRows input).
    const iso = (secondsSinceStart) =>
      new Date(Date.UTC(2026, 6, 27, 10, 0, secondsSinceStart)).toISOString();
    const row = (timestamp, i) => ({
      timestamp,
      engine_rpm: 1000 + i,
      vehicle_speed: 30 + (i % 20),
      values: {},
    });

    const head = Array.from({ length: 40 }, (_, i) => row(iso(i), i)); // ASC: 0..39
    const middle = Array.from({ length: 40 }, (_, i) => row(iso(40 + i), 40 + i)); // ASC: 40..79
    const descTail = Array.from({ length: 40 }, (_, i) => row(iso(119 - i), 80 + i)); // DESC: 119..80

    const unsorted = [...head, ...middle, ...descTail];

    // Fixture sanity check: this exact bug shape must render out of order at the
    // seam before the sort (the seam is order-preserving, so the sort upstream is
    // what restores the timeline).
    const rawCsv = buildTelemetryCsv(unsorted, []);
    const rawTimes = rawCsv.split('\n').slice(1).map((line) => line.split(',')[0]);
    assert.ok(
      rawTimes.some((time, idx) => idx > 0 && time < rawTimes[idx - 1]),
      'fixture should be out of chronological order before the sort'
    );

    // Same comparator the controller applies at its single choke point.
    const sorted = [...unsorted].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const csv = buildTelemetryCsv(sorted, []);
    const lines = csv.split('\n');
    // Plan 045 deliberately declares the unit on the prompt CSV columns
    // (metric included) so a model can never misread a converted number.
    assert.strictEqual(lines[0], 'Time,RPM,Speed (km/h)');
    const times = lines.slice(1).map((line) => line.split(',')[0]);
    assert.ok(times.length > 1, 'sample is large enough to exercise resampling');

    for (let i = 1; i < times.length; i++) {
      assert.ok(
        times[i] >= times[i - 1],
        `Time column must be monotonically non-decreasing; row ${i} (${times[i]}) sorts before row ${i - 1} (${times[i - 1]})`
      );
    }
  });
});

describe('sample statistics honesty + location sanitization (plans/032)', () => {
  function promptFor(session) {
    return buildAnalysisPrompt(session, {}, [], [], null);
  }

  it('labels the statistics block as sample-derived, never whole-drive', () => {
    const prompt = promptFor({ name: 'Morning Commute' });
    assert.ok(prompt.includes('## Sample Statistics (0 sampled rows)'));
    assert.ok(
      prompt.includes(
        'These values are computed from the sampled rows below, not necessarily the whole drive.'
      )
    );
    assert.ok(prompt.includes('say the sample may have missed it'));
    assert.ok(!prompt.includes('Entire Drive'));
    assert.ok(!prompt.includes('Pre-Calculated'));
    assert.ok(!prompt.includes('Use these exact calculated values'));
  });

  it('reports the sampled row count in the heading', () => {
    const sample = [
      { timestamp: '2026-10-01T10:00:00.000Z', engine_rpm: 900, vehicle_speed: 0, values: {} },
      { timestamp: '2026-10-01T10:00:01.000Z', engine_rpm: 950, vehicle_speed: 0, values: {} },
    ];
    const prompt = buildAnalysisPrompt({ name: 'Idle' }, {}, sample, [], null);
    assert.ok(prompt.includes('## Sample Statistics (2 sampled rows)'));
    assert.ok(prompt.includes('Data points in sample: 2'));
  });

  it('sanitizes newlines and truncates a 5000-char location', () => {
    const session = {
      name: 'Line one\nline two',
      startLocation: 'A'.repeat(5000),
      endLocation: 'B'.repeat(5000),
    };
    const prompt = promptFor(session);
    const locationLine = prompt.split('\n').find((line) => line.startsWith('Location: '));
    assert.ok(locationLine, 'prompt must carry a Location line');
    assert.ok(locationLine.length <= 220, `Location line is ${locationLine.length} chars`);
    assert.ok(!locationLine.includes('\n'));
    const contextName = prompt.split('\n').find((line) => line.startsWith('Session: '));
    assert.ok(contextName.includes('Line one line two'));
    assert.ok(!contextName.includes('\n'));
  });
});

describe('buildAnalysisPrompt vehicle context (plans/118)', () => {
  // The controller passes { ...session.toJSON(), duration } where toJSON()
  // serializes the eager-loaded Vehicle profile under the `Vehicle` key
  // (Session.belongsTo(Vehicle, { as: 'Vehicle' })). The session's profile
  // fields must win over the legacy Settings vehicle fields per-field, with
  // legacy values as the fallback when the profile lacks a field.
  const emptySample = [];
  const noPids = [];

  function buildPrompt(session, settings) {
    return buildAnalysisPrompt(session, settings, emptySample, noPids, null);
  }

  it('prefers the session Vehicle profile over legacy settings fields', () => {
    const session = {
      name: 'Morning Commute',
      Vehicle: { make: 'Mazda', model: 'CX-5', year: 2021, engineCc: 2500 },
    };
    const settings = {
      vehicleYear: 2010,
      vehicleMake: 'Ford',
      vehicleModel: 'Fiesta',
      engineCc: 1600,
    };
    const prompt = buildPrompt(session, settings);
    assert.ok(prompt.includes('Vehicle: 2021 Mazda CX-5'));
    assert.ok(prompt.includes('Engine: 2500cc'));
    assert.ok(!prompt.includes('Ford'), 'legacy vehicleMake must not leak in');
    assert.ok(!prompt.includes('Fiesta'), 'legacy vehicleModel must not leak in');
    assert.ok(!prompt.includes('2010'), 'legacy vehicleYear must not leak in');
    assert.ok(!prompt.includes('1600cc'), 'legacy engineCc must not leak in');
  });

  it('falls back to legacy settings fields when the session has no Vehicle (today behavior)', () => {
    const session = { name: 'Morning Commute' };
    const settings = {
      vehicleYear: 2015,
      vehicleMake: 'Honda',
      vehicleModel: 'Civic',
      engineCc: 1800,
    };
    const prompt = buildPrompt(session, settings);
    // Pin the exact rendered lines: byte-identical to the pre-profile output.
    assert.ok(prompt.includes('Vehicle: 2015 Honda Civic'));
    assert.ok(prompt.includes('Engine: 1800cc'));
    assert.ok(prompt.includes('a 1800cc engine'));
  });

  it('falls back per-field when the Vehicle profile leaves a field unset', () => {
    // The real serialized shape carries engineCc: null for an unset profile
    // field (nullable INTEGER, default null) — it must fall back to legacy.
    const session = {
      name: 'Morning Commute',
      Vehicle: { make: 'Toyota', model: 'Camry', year: 2018, engineCc: null },
    };
    const settings = {
      vehicleYear: 1998,
      vehicleMake: 'Ford',
      vehicleModel: 'Fiesta',
      engineCc: 2400,
    };
    const prompt = buildPrompt(session, settings);
    assert.ok(prompt.includes('Vehicle: 2018 Toyota Camry'));
    assert.ok(!prompt.includes('Ford'), 'profile make must beat legacy vehicleMake');
    assert.ok(prompt.includes('Engine: 2400cc'), 'engineCc must fall back to settings.engineCc');
    assert.ok(prompt.includes('a 2400cc engine'));
  });

  it('uses the resolved engineCc in the Idle RPM/MAP guardrail line', () => {
    const session = {
      name: 'Morning Commute',
      Vehicle: { make: 'BMW', model: '328i', year: 2016, engineCc: 2000 },
    };
    const settings = {
      vehicleYear: 2010,
      vehicleMake: 'Ford',
      vehicleModel: 'Fiesta',
      engineCc: 1600,
    };
    const prompt = buildPrompt(session, settings);
    assert.ok(
      prompt.includes('For a 2000cc engine under air conditioning'),
      'guardrail must use the session profile engineCc'
    );
    assert.ok(
      !prompt.includes('For a 1600cc engine'),
      'guardrail must not use the legacy settings.engineCc'
    );
  });

  it('resolves the same vehicle fields from buildContext directly', () => {
    const session = {
      name: 'Morning Commute',
      Vehicle: { make: 'Subaru', model: 'Outback', year: 2019, engineCc: 2500 },
    };
    const settings = { vehicleMake: 'Ford', engineCc: 9999 };
    const ctx = buildContext(session, settings, emptySample, noPids);
    assert.ok(ctx.includes('Vehicle: 2019 Subaru Outback'));
    assert.ok(ctx.includes('Engine: 2500cc'));
    assert.ok(!ctx.includes('Ford'));
    assert.ok(!ctx.includes('9999'));
  });
});

describe('unit-system prompt + guardrails (plan 045)', () => {
  const sample = [
    {
      timestamp: '2026-10-01T10:00:00.000Z',
      engine_rpm: 2000,
      vehicle_speed: 100,
      values: { kc: 2000, k5: 90, kb: 40 },
    },
    {
      timestamp: '2026-10-01T10:00:01.000Z',
      engine_rpm: 2100,
      vehicle_speed: 110,
      values: { kc: 2100, k5: 91, kb: 41 },
    },
  ];
  const pids = ['k5', 'kb'];
  const session = { name: 'Units', Vehicle: { engineCc: 2500 } };

  it('metric prompt keeps today’s guardrail wording (plus declared units)', () => {
    const p = buildAnalysisPrompt(session, {}, sample, pids, null, 'metric');
    assert.ok(p.includes('Units: Metric (km/h, °C, kPa, L, L/100km)'));
    assert.ok(p.includes('a 2500cc engine'));
    assert.ok(p.includes('MAP) around 40–45 kPa'));
    assert.ok(p.includes('unless speed is 0 km/h'));
    assert.ok(p.includes('minimum MAP (~24–26 kPa)'));
    assert.ok(p.includes('Speed (km/h)'));
    assert.ok(p.includes('Engine Coolant Temperature (°C)'));
  });

  it('US prompt declares US units, converts stats/CSV and has no kPa/km/h/°C', () => {
    const p = buildAnalysisPrompt(session, {}, sample, pids, null, 'us');
    assert.ok(p.includes('Units: US customary'));
    assert.ok(p.includes('All numeric values and column headers in this prompt are in US customary.'));
    assert.ok(p.includes('Report findings in the SAME units'));

    // Guardrails converted, not the metric metres.
    assert.ok(p.includes('MAP) around 5.8–6.5 psi'));
    assert.ok(p.includes('unless the vehicle is stationary'));
    assert.ok(p.includes('minimum MAP (~3.5–3.8 psi)'));
    assert.ok(p.includes('a 2.5 L (152.6 cu in) engine'));

    // Column headers + converted sample values.
    assert.ok(p.includes('Speed (mph)'));
    assert.ok(p.includes('Engine Coolant Temperature (°F)'));
    assert.ok(p.includes('Intake Manifold Pressure (psi)'));
    assert.ok(p.includes('62.14'));
    assert.ok(p.includes('194.00'));

    assert.ok(!p.includes('kPa'), 'US prompt must not mention kPa');
    assert.ok(!p.includes('km/h'), 'US prompt must not mention km/h');
    assert.ok(!p.includes('°C'), 'US prompt must not mention °C');
  });

  it('UK prompt uses psi with °C/MPG UK and the stationary wording', () => {
    const p = buildAnalysisPrompt(session, {}, sample, pids, null, 'uk');
    assert.ok(p.includes('Units: UK (mph, °C, psi, MPG UK)'));
    assert.ok(p.includes('MAP) around 5.8–6.5 psi'));
    assert.ok(p.includes('minimum MAP (~3.5–3.8 psi)'));
    assert.ok(p.includes('a 2.5 L engine'));
    assert.ok(p.includes('unless the vehicle is stationary'));
    assert.ok(p.includes('Engine Coolant Temperature (°C)'));
    assert.ok(p.includes('Speed (mph)'));
    assert.ok(!p.includes('kPa'));
    assert.ok(!p.includes('km/h'));
  });

  it('buildTelemetryCsv labels columns and converts values', () => {
    const us = buildTelemetryCsv(sample, pids, 'us').split('\n');
    assert.strictEqual(
      us[0],
      'Time,RPM,Speed (mph),Engine Coolant Temperature (°F),Intake Manifold Pressure (psi)',
    );
    const cells = us[1].split(',');
    assert.strictEqual(cells[1], '2000');
    assert.ok(Math.abs(Number(cells[2]) - 62.1371192237) < 1e-9);
    assert.strictEqual(cells[3], '194');
  });
});
