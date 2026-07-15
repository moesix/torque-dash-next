/**
 * PID Decode engine — discovers and extracts time-series data from telemetry
 * frames. Handles the unreliable `values` JSONB bag, metadata enrichment from
 * `userFullName*` / `userUnit*` keys, and a curated fallback map.
 *
 * Security: `coerceScalar` uses parseFloat + typeof guards only.
 *            NEVER eval / Function / JSON.parse on uploaded values.
 */

import type { TelemetryFrame, PidMeta, ColumnMeta, SeriesSource } from './types';

// ── Curated Torque OBD-II fallback map ───────────────────────────────────

const FALLBACK_MAP: Record<string, { full: string; short: string; unit: string }> = {
  k10:     { full: 'MAF Air Flow Rate',           short: 'MAF',       unit: 'g/s' },
  k11:     { full: 'Throttle Position',           short: 'Throttle',  unit: '%' },
  k2f:     { full: 'Fuel Level Input',            short: 'Fuel',      unit: '%' },
  k33:     { full: 'Barometric Pressure',          short: 'Baro',      unit: 'kPa' },
  k45:     { full: 'Relative Throttle Position',  short: 'R Throttle',unit: '%' },
  k47:     { full: 'Absolute Throttle Pos B',     short: 'Throttle B',unit: '%' },
  k49:     { full: 'Accel Pedal Position D',      short: 'Pedal D',   unit: '%' },
  k4a:     { full: 'Accel Pedal Position E',      short: 'Pedal E',   unit: '%' },
  k5:      { full: 'Engine Coolant Temperature',  short: 'Coolant',   unit: '°C' },
  kb:      { full: 'Intake Manifold Pressure',    short: 'MAP',       unit: 'psi' },
  kc:      { full: 'Engine RPM',                  short: 'Revs',      unit: 'rpm' },
  kd:      { full: 'Vehicle Speed (OBD)',         short: 'Speed',     unit: 'km/h' },
  ke:      { full: 'Timing Advance',              short: 'Timing',    unit: '°' },
  kf:      { full: 'Intake Air Temperature',      short: 'IAT',       unit: '°C' },
  kff1001: { full: 'MAF-derived Speed Est',       short: 'MAF Speed', unit: 'km/h' },
  kff1005: { full: 'Fuel Trim (Long Term)',       short: 'LTFT',      unit: '%' },
  kff1006: { full: 'Fuel Trim (Short Term)',      short: 'STFT',      unit: '%' },
  kff1007: { full: 'Engine Coolant Temperature (F)', short: 'Coolant (F)', unit: '°F' },
  kff1201: { full: 'Intake Air Temp',             short: 'IAT 2',     unit: '°C' },
  kff1214: { full: 'O2 Sensor 1 Voltage',         short: 'O2S1V',     unit: 'V' },
  kff1223: { full: 'Acceleration Sensor',          short: 'Accel',    unit: 'g' },
  kff1238: { full: 'OBD Adapter Voltage',          short: 'Adapter V',unit: 'V' },
  kff124d: { full: 'Commanded Air/Fuel Ratio',    short: 'AFR Cmd',   unit: ':1' },
  kff125a: { full: 'Fuel Flow Rate',              short: 'Fuel Flow', unit: 'cc/min' },
  kff1278: { full: 'Boost Pressure',              short: 'Boost',     unit: 'psi' },
};

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Coerce an unknown value to a number, or null when not possible.
 *
 * Security: parseFloat + typeof guards only.  NEVER eval / Function / JSON.parse.
 * Handles Torque's quirks: sometimes a simple number, sometimes a string, and
 * sometimes (k0c / RPM) an array of label strings — we try to extract a numeric
 * value from the first element.
 */
export function coerceScalar(v: unknown): number | null {
  if (typeof v === 'number') return isNaN(v) ? null : v;

  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  if (Array.isArray(v) && v.length > 0) {
    // k0c is sometimes a label array like
    // ["ECU(7E9): Engine RPM","Engine RPM"] — try first element.
    return coerceScalar(v[0]);
  }

  return null;
}

/** Safely extract a string value from unknown, handling Torque metadata arrays. */
function extractString(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (Array.isArray(val) && val.length > 0) {
    const first = val[0];
    if (typeof first === 'string') return first;
  }
  return undefined;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Build the full available series list for a set of frames:
 *
 * 1. Always include dedicated columns (engineRpm, vehicleSpeed).
 * 2. Scan ALL frames for distinct `k*` keys in `values` → candidate PIDs.
 * 3. Scan ALL frames for metadata keys (`userFullName*`, `userShortName*`,
 *    `userUnit*`, `defaultUnit*`) to enrich display names / units.
 * 4. Resolve display via metadata > fallback map > raw key.
 * 5. Exclude metadata-only keys from the result — only `^k*` keys become PIDs.
 * 6. Return deduplicated, sorted by full name.
 */
export function getAvailableSeries(frames: TelemetryFrame[]): SeriesSource[] {
  // ── 1. Column sources (always present) ───────────────────────────────
  const results: SeriesSource[] = [
    {
      pid: 'engineRpm',
      full: 'Engine RPM',
      short: 'RPM',
      unit: 'rpm',
      source: 'column',
      field: 'engineRpm',
    },
    {
      pid: 'vehicleSpeed',
      full: 'Vehicle Speed',
      short: 'Speed',
      unit: 'km/h',
      source: 'column',
      field: 'vehicleSpeed',
    },
  ];

  // ── 2 & 3. Scan every frame for k* value keys + metadata ────────────
  const pidValueKeys = new Set<string>();
  // metaKey = PID suffix (e.g. "ff1007" for userFullNameff1007)
  const metaMap = new Map<string, { full?: string; short?: string; unit?: string }>();

  for (const frame of frames) {
    if (!frame.values) continue;

    for (const [key, val] of Object.entries(frame.values)) {
      // Candidate PID value keys start with "k"
      if (key.startsWith('k') && key.length > 1) {
        pidValueKeys.add(key);
        continue;
      }

      // Metadata keys — extract PID suffix
      let pid: string | undefined;

      if (key.startsWith('userFullName')) {
        pid = key.slice('userFullName'.length);
        if (pid) {
          if (!metaMap.has(pid)) metaMap.set(pid, {});
          const s = extractString(val);
          if (s) metaMap.get(pid)!.full = s;
        }
      }

      if (key.startsWith('userShortName')) {
        pid = key.slice('userShortName'.length);
        if (pid) {
          if (!metaMap.has(pid)) metaMap.set(pid, {});
          const s = extractString(val);
          if (s) metaMap.get(pid)!.short = s;
        }
      }

      if (key.startsWith('userUnit')) {
        pid = key.slice('userUnit'.length);
        if (pid) {
          if (!metaMap.has(pid)) metaMap.set(pid, {});
          const s = extractString(val);
          if (s) metaMap.get(pid)!.unit = s;
        }
      }

      if (key.startsWith('defaultUnit')) {
        pid = key.slice('defaultUnit'.length);
        if (pid) {
          if (!metaMap.has(pid)) metaMap.set(pid, {});
          // defaultUnit is a lower-priority fallback for unit
          const entry = metaMap.get(pid)!;
          if (!entry.unit) {
            const s = extractString(val);
            if (s) entry.unit = s;
          }
        }
      }
    }
  }

  // ── 4. Build pid sources from candidate keys ─────────────────────────
  for (const valueKey of pidValueKeys) {
    // valueKey = "k0c" → pid = "0c"
    const pidSuffix = valueKey.slice(1);
    let meta = metaMap.get(pidSuffix);
    // Metadata keys use leading zeros for single-char PID suffixes
    // e.g. data key "k5" → pidSuffix="5" but metadata has "05"
    if (!meta && pidSuffix.length === 1) {
      meta = metaMap.get('0' + pidSuffix);
    }
    const fallback = FALLBACK_MAP[valueKey];

    const full = meta?.full ?? fallback?.full ?? valueKey;
    const short = meta?.short ?? fallback?.short ?? valueKey;
    const unit = meta?.unit ?? fallback?.unit ?? '';

    results.push({
      pid: valueKey,
      full,
      short,
      unit,
      source: 'pid',
    });
  }

  // ── 5 & 6. Deduplicate by pid, sort by full name ───────────────────
  const seen = new Set<string>();
  return results
    .filter((r) => {
      if (seen.has(r.pid)) return false;
      seen.add(r.pid);
      return true;
    })
    .sort((a, b) => a.full.localeCompare(b.full));
}

/**
 * Extract time-series data for a single source from frames.
 *
 * For column sources reads the dedicated field; for pid sources reads
 * from `values` via `coerceScalar`.  Returns `[timestamp_ms, value | null]`
 * pairs suitable for ECharts.
 */
export function getSeriesData(
  frames: TelemetryFrame[],
  source: SeriesSource,
): [number, number | null][] {
  const data: [number, number | null][] = new Array(frames.length);

  if (source.source === 'column') {
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      data[i] = [
        new Date(f.timestamp).getTime(),
        // Use coerceScalar to safely cast the TelemetryFrame field value
        coerceScalar(f[source.field]),
      ];
    }
  } else {
    // pid source — read from values bag
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const raw = f.values?.[source.pid];
      data[i] = [
        new Date(f.timestamp).getTime(),
        coerceScalar(raw),
      ];
    }
  }

  return data;
}

/**
 * Compute aggregate stats for a source from its series data.
 * Returns null when no valid (non-null) data points exist.
 */
export function computeStats(
  data: [number, number | null][],
): { min: number; max: number; avg: number; last: number | null } | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  let last: number | null = null;

  for (let i = 0; i < data.length; i++) {
    const v = data[i][1];
    if (v === null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
    last = v;
  }

  if (count === 0) return null;

  return { min, max, avg: sum / count, last };
}
