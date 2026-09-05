import { useMemo } from 'react';
import type { TelemetryFrame } from '@/lib/types';
import { getSeriesData } from '@/lib/pidDecode';
import { usePlaybackStore } from '@/app/playbackStore';

interface Props {
  frames: TelemetryFrame[];
  maxRpm: number | null;
  maxSpeed: number | null;
  maxCoolant: number | null;
}

// ── Stats helper ────────────────────────────────────────────────────────────

/**
 * Compute min / max / median over the non-null values of a series.
 * Returns null when there is no usable data (empty or null-only input).
 * The input is sorted internally, so callers may pass unsorted series.
 */
export function stats(
  values: (number | null)[],
): { min: number; max: number; median: number } | null {
  const v = values.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { min: v[0], max: v[v.length - 1], median };
}

/** Extract a number-only array of series values ([timestamp, value][]) → value[]. */
function seriesValues(data: [number, number | null][]): (number | null)[] {
  return data.map((d) => d[1]);
}

// ── SVG Ring Gauge ──────────────────────────────────────────────────────────

interface GaugeProps {
  label: string;
  value: number;
  max: number;
  unit: string;
  color: string;
}

function RingGauge({ label, value, max, unit, color }: GaugeProps) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const pct = max > 0 ? Math.max(0, Math.min(1, safeValue / max)) : 0;
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const dash = pct * circumference;
  const display = Math.round(safeValue);

  return (
    <div className="flex flex-col items-center">
      <svg
        width="100"
        height="100"
        viewBox="0 0 100 100"
        role="img"
        aria-label={`${label}: ${display}${unit}`}
      >
        {/* Background ring */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          className="stroke-gray-200 dark:stroke-gray-700"
          strokeWidth="8"
        />
        {/* Colored arc */}
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 50 50)"
        />
        {/* Value text */}
        <text
          x="50"
          y="46"
          textAnchor="middle"
          fontSize="16"
          fontWeight="700"
          className="fill-gray-900 dark:fill-gray-100"
        >
          {display}
        </text>
        {/* Unit text */}
        <text
          x="50"
          y="62"
          textAnchor="middle"
          fontSize="9"
          className="fill-gray-500 dark:fill-gray-400"
        >
          {unit.trim()}
        </text>
      </svg>
      <p className="mt-1 text-xs leading-relaxed text-center">{label}</p>
    </div>
  );
}

// ── Binary search for closest frame to cursorTime ───────────────────────────

function findClosestFrame(
  timestamps: number[],
  cursorTime: number,
): number {
  if (timestamps.length === 0) return -1;

  let lo = 0;
  let hi = timestamps.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timestamps[mid] < cursorTime) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // lo is now the first index >= cursorTime; check neighbours for closest
  if (lo > 0) {
    const diffPrev = Math.abs(timestamps[lo - 1] - cursorTime);
    const diffCurr = Math.abs(timestamps[lo] - cursorTime);
    if (diffPrev < diffCurr) return lo - 1;
  }
  return lo;
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function SessionSummaryCard({
  frames,
  maxRpm,
  maxSpeed,
  maxCoolant,
}: Props) {
  const cursorTime = usePlaybackStore((s) => s.cursorTime);

  // Pre-compute sorted timestamp array for binary search
  const sortedTimestamps = useMemo(() => {
    return frames.map((f) => new Date(f.timestamp).getTime());
  }, [frames]);

  // Get series data for each PID
  const rpmData = useMemo(
    () =>
      getSeriesData(frames, {
        pid: 'kc',
        full: 'Engine RPM',
        short: 'Revs',
        unit: 'rpm',
        source: 'pid',
      }),
    [frames],
  );

  const coolantData = useMemo(
    () =>
      getSeriesData(frames, {
        pid: 'k5',
        full: 'Engine Coolant Temperature',
        short: 'Coolant',
        unit: '°C',
        source: 'pid',
      }),
    [frames],
  );

  const speedData = useMemo(
    () =>
      getSeriesData(frames, {
        pid: 'vehicleSpeed',
        full: 'Vehicle Speed',
        short: 'Speed',
        unit: 'km/h',
        source: 'column',
        field: 'vehicleSpeed',
      }),
    [frames],
  );

  // Compute per-metric stats from the SAME series the gauges use
  const rpmStats = useMemo(() => stats(seriesValues(rpmData)), [rpmData]);
  const coolantStats = useMemo(() => stats(seriesValues(coolantData)), [coolantData]);
  const speedStats = useMemo(() => stats(seriesValues(speedData)), [speedData]);

  // Find current values at cursor position
  const currentValues = useMemo(() => {
    if (cursorTime == null || frames.length === 0) {
      return { rpm: 0, coolant: 0, speed: 0 };
    }

    const idx = findClosestFrame(sortedTimestamps, cursorTime);
    if (idx < 0) return { rpm: 0, coolant: 0, speed: 0 };

    return {
      rpm: rpmData[idx]?.[1] ?? 0,
      coolant: coolantData[idx]?.[1] ?? 0,
      speed: speedData[idx]?.[1] ?? 0,
    };
  }, [cursorTime, sortedTimestamps, rpmData, coolantData, speedData, frames.length]);

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 md:p-6 shadow-xs">
      <h3 className="text-lg font-semibold leading-relaxed">Session Summary</h3>

      {/* Top: 3 SVG ring gauges */}
      <div className="flex items-center justify-around py-4 flex-wrap gap-2" aria-live="polite">
        <RingGauge
          label="RPM"
          value={currentValues.rpm}
          max={maxRpm ?? 8000}
          unit=" rpm"
          color="#009999"
        />
        <RingGauge
          label="Coolant"
          value={currentValues.coolant}
          max={maxCoolant ?? 120}
          unit="°C"
          color="#d97706"
        />
        <RingGauge
          label="Speed"
          value={currentValues.speed}
          max={maxSpeed ?? 240}
          unit=" km/h"
          color="#16a34a"
        />
      </div>

      {/* Bottom: Min / Max / Median table (doubles as the print
          "Summarised Session Info" block) */}
      <div className="border-t pt-2 pb-1 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 dark:text-[var(--text-muted)]">
              <th className="py-1 pr-2 font-medium">Metric</th>
              <th className="py-1 pr-2 text-right font-medium">Min</th>
              <th className="py-1 pr-2 text-right font-medium">Max</th>
              <th className="py-1 text-right font-medium">Median</th>
            </tr>
          </thead>
          <tbody className="text-gray-700 dark:text-[var(--text-secondary)]">
            {[
              { label: 'Engine RPM', unit: 'rpm', s: rpmStats },
              { label: 'Coolant', unit: '°C', s: coolantStats },
              { label: 'Speed', unit: 'km/h', s: speedStats },
            ].map((row) => (
              <tr key={row.label} className="border-t border-gray-100 dark:border-[var(--border-default)]">
                <td className="py-1 pr-2 font-medium">
                  {row.label}
                  <span className="ml-1 text-gray-400 dark:text-[var(--text-muted)]">{row.unit}</span>
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {row.s != null ? Math.round(row.s.min) : '—'}
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {row.s != null ? Math.round(row.s.max) : '—'}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {row.s != null ? Math.round(row.s.median) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
