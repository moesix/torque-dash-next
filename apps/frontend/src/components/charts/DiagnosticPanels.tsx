/**
 * Container for pre-configured diagnostic graph panels.
 *
 * Each panel is a self-contained ECharts chart with a specific set of PIDs
 * and a layout tailored to that diagnostic domain. Panels are collapsed by
 * default and only render if their required PIDs exist in the session data.
 */

import { useMemo } from 'react';
import type { TelemetryFrame, SeriesSource } from '@/lib/types';
import DiagnosticPanel from './DiagnosticPanel';
import type {
  ComputedSeries,
  MarkLineConfig,
  MarkAreaConfig,
  DiagnosticPanelProps,
} from './DiagnosticPanel';
import { computeTotalTrim } from '@/lib/pidDecode';

// ── Props ────────────────────────────────────────────────────────────────

interface Props {
  frames: TelemetryFrame[];
  available: SeriesSource[];
  /** When true every panel renders expanded — print mode. */
  forceExpanded?: boolean;
}

// ── Module-level constants ────────────────────────────────────────────────
//
// Hoisted to module scope so every DiagnosticPanel prop keeps a stable
// reference across parent re-renders. ReplayDashboard re-renders up to 60×/s
// during playback (cursor ticks), and DiagnosticPanel is React.memo'd: fresh
// inline array/object literals here would change identity on every render,
// defeat the memo, and re-run each panel's full data-rebuild effect (a
// 100k-frame getSeriesData rescan + a notMerge setOption) per tick.

type AxisOverrides = NonNullable<DiagnosticPanelProps['yAxisOverrides']>;

const PIDS_RPM_SPEED = ['engineRpm', 'vehicleSpeed'] as const;
const PIDS_FUEL_TRIM = ['k6', 'k7'] as const;
const PIDS_O2_AFR = ['kff1214', 'kff124d'] as const;
const PIDS_COOLANT = ['k5'] as const;
const PIDS_BOOST_MAF = ['kff1278', 'k10'] as const;
const PIDS_THROTTLE_PEDAL = ['k11', 'k49'] as const;

const YAXIS_RPM_SPEED: AxisOverrides = { 0: {}, 1: {} }; // RPM left, Speed right
const YAXIS_O2_AFR: AxisOverrides = { 0: {}, 1: {} }; // O2 voltage left, AFR right
const YAXIS_COOLANT: AxisOverrides = { 0: { min: 60, max: 95 } };
const YAXIS_BOOST_MAF: AxisOverrides = { 0: {}, 1: {} }; // Boost left, MAF right

const FUEL_TRIM_MARK_LINES: MarkLineConfig[] = [
  { yAxis: 0, color: '#9ca3af', type: 'dashed' },
];
const FUEL_TRIM_MARK_AREAS: MarkAreaConfig[] = [
  { yFrom: -10, yTo: 10, color: 'rgba(0,153,153,0.15)' },
];

// ── Helpers ──────────────────────────────────────────────────────────────

/** Check if all required PIDs exist in the available series. */
function hasPids(required: string[], available: SeriesSource[]): boolean {
  const pidSet = new Set(available.map((s) => s.pid));
  return required.every((pid) => pidSet.has(pid));
}

// ── Component ────────────────────────────────────────────────────────────

export default function DiagnosticPanels({ frames, available, forceExpanded = false }: Props) {
  // Pre-compute Total Trim series (memoized — only recomputes when frames change)
  const totalTrimData = useMemo(() => computeTotalTrim(frames), [frames]);

  const totalTrimSeries: ComputedSeries = useMemo(() => ({
    label: 'Total Trim',
    color: '#dc2626',
    compute: () => totalTrimData,
    yAxisIndex: 0,
  }), [totalTrimData]);

  // Stable wrapper array for the Total Trim series. An inline `[totalTrimSeries]`
  // literal would be a fresh reference per render and defeat DiagnosticPanel's
  // memo (per-tick rebuild of the Fuel Trims panel).
  const totalTrimSeriesList: ComputedSeries[] = useMemo(
    () => [totalTrimSeries],
    [totalTrimSeries],
  );

  // Check which panels should render (conditional PIDs)
  const showBoostMaf = hasPids(['kff1278', 'k10'], available);
  const showThrottlePedal = hasPids(['k11', 'k49'], available);

  return (
    <div className="space-y-3">
      {/* Panel 1: Engine RPM & Vehicle Speed */}
      <DiagnosticPanel
        title="Engine RPM & Vehicle Speed"
        frames={frames}
        pids={PIDS_RPM_SPEED}
        yAxisOverrides={YAXIS_RPM_SPEED}
        forceExpanded={forceExpanded}
      />

      {/* Panel 2: Fuel Trims */}
      <DiagnosticPanel
        title="Fuel Trims"
        frames={frames}
        pids={PIDS_FUEL_TRIM}
        computedSeries={totalTrimSeriesList}
        markLines={FUEL_TRIM_MARK_LINES}
        markAreas={FUEL_TRIM_MARK_AREAS}
        forceExpanded={forceExpanded}
      />

      {/* Panel 3: O2 Sensor & AFR */}
      <DiagnosticPanel
        title="O2 Sensor & AFR"
        frames={frames}
        pids={PIDS_O2_AFR}
        yAxisOverrides={YAXIS_O2_AFR}
        forceExpanded={forceExpanded}
      />

      {/* Panel 4: Engine Coolant Temp */}
      <DiagnosticPanel
        title="Engine Coolant Temp"
        frames={frames}
        pids={PIDS_COOLANT}
        yAxisOverrides={YAXIS_COOLANT}
        forceExpanded={forceExpanded}
      />

      {/* Panel 5: Boost & MAF (conditional — only if PIDs exist) */}
      {showBoostMaf && (
        <DiagnosticPanel
          title="Boost & MAF"
          frames={frames}
          pids={PIDS_BOOST_MAF}
          yAxisOverrides={YAXIS_BOOST_MAF}
          forceExpanded={forceExpanded}
        />
      )}

      {/* Panel 6: Throttle & Pedal (conditional — only if both PIDs exist) */}
      {showThrottlePedal && (
        <DiagnosticPanel
          title="Throttle & Pedal"
          frames={frames}
          pids={PIDS_THROTTLE_PEDAL}
          // Both are %, single Y-axis — no overrides needed
          forceExpanded={forceExpanded}
        />
      )}
    </div>
  );
}
