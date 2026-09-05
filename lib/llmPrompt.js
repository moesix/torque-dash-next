const { PID_REGISTRY } = require('./pidRegistry');

/**
 * Computes min, max, mean, and median for numeric fields across telemetry rows.
 * Also computes Combined Fuel Trim (STFT + LTFT) per-row to prevent index misalignment.
 *
 * IMPORTANT: Filter null/empty values BEFORE converting to Number().
 * Number(null) === 0 and Number('') === 0, which corrupts statistics.
 */
function computeSummaryStats(telemetrySample, pidKeys) {
  const numericKeys = ['engine_rpm', 'vehicle_speed', ...pidKeys];
  const stats = {};

  for (const key of numericKeys) {
    // Filter BEFORE converting to Number — Number(null) === 0, Number('') === 0
    const values = telemetrySample
      .map(r => (key in r ? r[key] : r.values?.[key]))
      .filter(v => v !== null && v !== undefined && v !== '')
      .map(v => Number(v))
      .filter(v => !Number.isNaN(v));

    if (!values.length) continue;

    values.sort((a, b) => a - b);
    const min = values[0];
    const max = values[values.length - 1];
    const sum = values.reduce((acc, v) => acc + v, 0);
    const mean = sum / values.length;
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 !== 0
      ? values[mid]
      : (values[mid - 1] + values[mid]) / 2;

    const pidName = PID_REGISTRY[key]?.fullName || key;
    const unit = PID_REGISTRY[key]?.unit || '';
    stats[key] = { pidName, unit, min, max, mean, median, count: values.length };
  }

  // Combined Fuel Trim (STFT + LTFT) — calculated PER ROW to prevent
  // index misalignment when packets are dropped (different array lengths).
  // Check for null/undefined BEFORE converting to Number.
  const totalTrims = [];
  for (const row of telemetrySample) {
    const stftRaw = row.values?.k6;
    const ltftRaw = row.values?.k7;
    if (stftRaw != null && ltftRaw != null) {
      const stft = Number(stftRaw);
      const ltft = Number(ltftRaw);
      if (!Number.isNaN(stft) && !Number.isNaN(ltft)) {
        totalTrims.push(stft + ltft);
      }
    }
  }

  if (totalTrims.length > 0) {
    totalTrims.sort((a, b) => a - b);
    const sum = totalTrims.reduce((acc, v) => acc + v, 0);
    const mid = Math.floor(totalTrims.length / 2);
    stats['total_fuel_trim'] = {
      pidName: 'Combined Fuel Trim (STFT + LTFT)',
      unit: '%',
      min: totalTrims[0],
      max: totalTrims[totalTrims.length - 1],
      mean: sum / totalTrims.length,
      median: totalTrims.length % 2 !== 0
        ? totalTrims[mid]
        : (totalTrims[mid - 1] + totalTrims[mid]) / 2,
      count: totalTrims.length,
    };
  }

  return stats;
}

/**
 * Formats a trip duration as HH:MM:SS from two timestamps.
 * Returns 'unknown' when either bound is missing or the span is negative
 * (session row created after the last log — e.g. backfilled uploads).
 * plans/087: the AI prompt must never contain a negative duration.
 */
function formatSessionDuration(startTs, endTs) {
  if (!startTs || !endTs) return 'unknown';
  const ms = new Date(endTs).getTime() - new Date(startTs).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

// plans/089 — connectivity-gap detection thresholds.
const GAP_ANALYSIS = {
  // A silence in the log timeline longer than this is a connectivity gap,
  // not an idling engine (the Torque app samples ~1 Hz while running, so
  // 5 s of total silence means the engine was off or the connection dropped).
  MIN_GAP_SECONDS: 5,
  // A minute receiving more rows than this is a backfill burst. The Torque
  // app samples ~1 Hz → ~60 rows/min nominal, and >1 Hz loggers can exceed
  // that, so this threshold flags only genuine buffered-upload bursts. The DB
  // dedups on the exact stored timestamp (ms precision), NOT per second.
  BURST_ROWS_PER_MINUTE: 90,
  // Report at most this many gaps in the prompt (sorted by length, desc).
  MAX_REPORTED_GAPS: 3,
};

/**
 * Detects connectivity gaps and backfill bursts in a FULL-resolution log
 * timestamp series (the sampled 80 rows cannot represent holes).
 * Returns { gaps: [{ startIso, endIso, seconds }], maxRowsInMinute }.
 * Gaps are intervals >= MIN_GAP_SECONDS between consecutive sorted
 * timestamps; the result is sorted longest-first and capped at
 * MAX_REPORTED_GAPS. Per-minute row counts drive burst detection.
 * plans/089: tells the model the discontinuity is missing data, not a fault.
 */
function detectBackfillGaps(timestamps) {
  const times = (timestamps || [])
    .map(t => new Date(t).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const gaps = [];
  const perMinute = new Map();
  for (const t of times) {
    const minuteKey = Math.floor(t / 60000);
    perMinute.set(minuteKey, (perMinute.get(minuteKey) || 0) + 1);
  }

  for (let i = 1; i < times.length; i++) {
    const seconds = (times[i] - times[i - 1]) > 0 ? (times[i] - times[i - 1]) / 1000 : 0;
    if (seconds >= GAP_ANALYSIS.MIN_GAP_SECONDS) {
      gaps.push({
        startIso: new Date(times[i - 1]).toISOString(),
        endIso: new Date(times[i]).toISOString(),
        seconds: Math.round(seconds),
      });
    }
  }
  gaps.sort((a, b) => b.seconds - a.seconds);

  let maxRowsInMinute = 0;
  for (const count of perMinute.values()) {
    if (count > maxRowsInMinute) maxRowsInMinute = count;
  }

  return { gaps: gaps.slice(0, GAP_ANALYSIS.MAX_REPORTED_GAPS), maxRowsInMinute };
}

/**
 * Builds the human-readable "Data quality" note for the AI prompt from a
 * detectBackfillGaps result. Returns null when nothing notable exists
 * (no gaps, no burst) so the prompt stays byte-identical for clean sessions.
 * plans/089: the note names the discontinuity as MISSING DATA so the model
 * stops speculating about engine stalls or sensor dropouts.
 */
function buildDataQualityNote(gapResult) {
  if (!gapResult) return null;
  const { gaps, maxRowsInMinute } = gapResult;
  const notes = [];
  if (gaps.length) {
    const list = gaps.map(g => `${g.seconds}s (ends ${g.endIso.slice(11, 19)}Z)`).join('; ');
    notes.push(`Connectivity gap${gaps.length > 1 ? 's' : ''} in the telemetry record: ${list}. The device buffered logs during an outage and backfilled them later; treat the discontinuity as missing data, NOT an engine stall, sensor dropout, or fault.`);
  }
  if (maxRowsInMinute > GAP_ANALYSIS.BURST_ROWS_PER_MINUTE) {
    notes.push(`Backfill burst detected (peak ${maxRowsInMinute} rows in one minute vs ~60 nominal): a block of buffered logs was uploaded at once. Rows are deduplicated on identical stored timestamps (ms precision), so values remain valid.`);
  }
  return notes.length ? notes.join(' ') : null;
}

function buildContext(session, settings, telemetrySample, pidKeys) {
  const lines = [];

  const parts = [];
  if (settings.vehicleYear) parts.push(String(settings.vehicleYear));
  if (settings.vehicleMake) parts.push(settings.vehicleMake);
  if (settings.vehicleModel) parts.push(settings.vehicleModel);
  if (parts.length) lines.push(`Vehicle: ${parts.join(' ')}`);
  if (settings.engineCc) lines.push(`Engine: ${settings.engineCc}cc`);

  const sanitize = (s) => String(s).replace(/[\n\r]/g, ' ').substring(0, 100);
  const sessionName = session.name ? sanitize(session.name) : 'Unnamed';
  lines.push(`Session: ${sessionName}`);
  if (session.startLocation && session.startLocation !== '-') {
    lines.push(`Location: ${session.startLocation} → ${session.endLocation || '?'}`);
  }

  lines.push(`Duration: ${session.duration || 'unknown'}`);
  lines.push(`Data points in sample: ${telemetrySample.length}`);
  lines.push(`PID keys discovered: ${pidKeys.join(', ') || 'none'}`);

  return lines.join('\n');
}

/**
 * Resamples telemetry evenly across the timeline rather than dropping middle rows.
 * Ensures the LLM sees data from start, middle cruising, and end of every drive.
 */
function resampleTelemetry(telemetrySample, maxRows = 80) {
  if (telemetrySample.length <= maxRows) return telemetrySample;
  const step = (telemetrySample.length - 1) / (maxRows - 1);
  const sampled = [];
  for (let i = 0; i < maxRows; i++) {
    const index = Math.round(i * step);
    sampled.push(telemetrySample[index]);
  }
  return sampled;
}

/**
 * Returns raw CSV instead of a Markdown table to save ~30% on LLM tokens.
 * Uses uniform resampling instead of head/tail slicing.
 */
function buildTelemetryCsv(telemetrySample, pidKeys) {
  if (!telemetrySample.length) return '(no telemetry data)';

  const rows = resampleTelemetry(telemetrySample, 80);

  const colNames = [
    'Time',
    'RPM',
    'Speed',
    ...pidKeys.map(k => PID_REGISTRY[k]?.fullName || k),
  ];

  const lines = [];
  lines.push(colNames.join(','));

  for (const row of rows) {
    // Regex safely extracts HH:mm:ss from ISO or space-separated date strings
    const tsString = String(row.timestamp || '');
    const timeMatch = tsString.match(/\d{2}:\d{2}:\d{2}/);
    const timeParsed = timeMatch ? timeMatch[0] : '';

    const values = row.values || {};
    const cells = [
      timeParsed,
      row.engine_rpm ?? '',
      row.vehicle_speed ?? '',
      ...pidKeys.map(k => values[k] ?? ''),
    ];
    lines.push(cells.join(','));
  }

  return lines.join('\n');
}

function buildAnalysisPrompt(session, settings, telemetrySample, pidKeys, dataQuality) {
  const context = buildContext(session, settings, telemetrySample, pidKeys);
  const stats = computeSummaryStats(telemetrySample, pidKeys);
  const telemetryData = buildTelemetryCsv(telemetrySample, pidKeys);

  const engineSizeStr = settings.engineCc
    ? `a ${settings.engineCc}cc engine`
    : 'this engine';

  // Format pre-computed stats block with units from PID_REGISTRY
  const statsLines = Object.entries(stats).map(([key, s]) => {
    const unitStr = s.unit ? ` [${s.unit}]` : '';
    return `- **${s.pidName} (${key})**${unitStr}: Min: ${s.min.toFixed(2)} | Max: ${s.max.toFixed(2)} | Mean: ${s.mean.toFixed(2)} | Median: ${s.median.toFixed(2)}`;
  });

  return `You are an expert automotive diagnostic engineer analyzing OBD-II telemetry from a Torque Pro session.

## Vehicle & Session Context
${context}

## Pre-Calculated Statistical Aggregates (Entire Drive)
Use these exact calculated values for overall analysis rather than manually estimating from the sample table:
${statsLines.join('\n')}

## Diagnostic Guardrails & Domain Knowledge
1. **Fuel Trims**: Combined Fuel Trim (STFT + LTFT) within ±10% is normal closed-loop operation. DO NOT report a vacuum leak or fueling issue if LTFT is negative or total trim is within ±10%. A vacuum leak requires high POSITIVE fuel trims (+15% to +25%).
2. **Idle RPM & MAP**: For ${engineSizeStr} under air conditioning (A/C) load, idling at 800–900 RPM with intake pressure (MAP) around 40–45 kPa is expected. Do NOT flag these values as abnormal unless speed is 0 km/h AND coolant temp is severely out of bounds without A/C load.
3. **Ignition Timing**: Brief zero or negative timing advance (-1° to -5°) during deceleration or gear transitions is standard ECU torque management. Only flag timing as problematic if it stays negative under acceleration or load.
4. **Deceleration Fuel Cut-off (DFCO)**: Spikes in AFR (e.g., >20.0) accompanied by minimum MAP (~24–26 kPa) during throttle lift-off are normal fuel-saving behavior, not lean misfires.
${dataQuality ? `5. **Data Quality**: ${dataQuality}\n` : ''}
## Resampled Telemetry Data (CSV Format)
${telemetryData}

## Analysis Request
Provide a crisp, expert mechanical analysis:

1. **Engine Health Assessment** — Thermal regulation, closed-loop fueling control, intake pressure stability.
2. **Driving Behavior** — Acceleration smooth/aggressive, cruising stability, DFCO usage.
3. **Fuel Efficiency Observations** — Closed-loop efficiency, idle time impact, deceleration coasting.
4. **Potential Mechanical Concerns** — Flag genuine anomalies only. If everything operates within normal tolerance, state clearly that the engine is healthy.
5. **Recommendations** — Actionable advice or routine checks.

## Output Format Requirements
- Use ## for main headings and ### for subheadings.
- Use **bold** for key findings and metric names.
- Use status indicators (✅ Normal, ⚠️ Monitor, ❌ Fault).
- Keep descriptions grounded in vehicle physics and mechanical reality.
- Avoid over-diagnosing standard operating quirks.`;
}

module.exports = { buildAnalysisPrompt, buildTelemetryCsv, buildContext, computeSummaryStats, formatSessionDuration, resampleTelemetry, detectBackfillGaps, buildDataQualityNote, GAP_ANALYSIS };
