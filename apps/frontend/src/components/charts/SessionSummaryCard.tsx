import { useMemo } from 'react';
import { Card, Text, Title } from '@tremor/react';
import type { TelemetryFrame } from '@/lib/types';
import { getSeriesData } from '@/lib/pidDecode';
import { usePlaybackStore } from '@/app/playbackStore';

interface Props {
  frames: TelemetryFrame[];
  maxRpm: number | null;
  maxSpeed: number | null;
  maxCoolant: number | null;
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
      <Text className="mt-1 text-xs text-center">{label}</Text>
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
        pid: 'engineRpm',
        full: 'Engine RPM',
        short: 'RPM',
        unit: 'rpm',
        source: 'column',
        field: 'engineRpm',
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
    <Card>
      <Title>Session Summary</Title>

      {/* Top: 3 SVG ring gauges */}
      <div className="flex items-center justify-around py-4 flex-wrap gap-2" aria-live="polite">
        <RingGauge
          label="RPM"
          value={currentValues.rpm}
          max={maxRpm ?? 8000}
          unit=" rpm"
          color="#2563eb"
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

      {/* Bottom: Max values row */}
      <div className="border-t pt-2 pb-1 flex items-center justify-center gap-4 text-xs text-gray-500 flex-wrap">
        <span>
          Max RPM: <strong>{maxRpm != null ? Math.round(maxRpm) : '—'}</strong>
        </span>
        <span className="text-gray-300">·</span>
        <span>
          Max Speed:{' '}
          <strong>{maxSpeed != null ? `${Math.round(maxSpeed)} km/h` : '—'}</strong>
        </span>
        <span className="text-gray-300">·</span>
        <span>
          Max Coolant:{' '}
          <strong>{maxCoolant != null ? `${Math.round(maxCoolant)}°C` : '—'}</strong>
        </span>
      </div>
    </Card>
  );
}
