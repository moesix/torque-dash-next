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
import type { ComputedSeries, MarkLineConfig, MarkAreaConfig } from './DiagnosticPanel';
import { computeTotalTrim } from '@/lib/pidDecode';

// ── Props ────────────────────────────────────────────────────────────────

interface Props {
  frames: TelemetryFrame[];
  available: SeriesSource[];
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Check if all required PIDs exist in the available series. */
function hasPids(required: string[], available: SeriesSource[]): boolean {
  const pidSet = new Set(available.map((s) => s.pid));
  return required.every((pid) => pidSet.has(pid));
}

// ── Component ────────────────────────────────────────────────────────────

export default function DiagnosticPanels({ frames, available }: Props) {
  // Pre-compute Total Trim series (memoized — only recomputes when frames change)
  const totalTrimData = useMemo(() => computeTotalTrim(frames), [frames]);

  const totalTrimSeries: ComputedSeries = useMemo(() => ({
    label: 'Total Trim',
    color: '#dc2626',
    compute: () => totalTrimData,
    yAxisIndex: 0,
  }), [totalTrimData]);

  // Fuel Trims mark config
  const fuelTrimMarkLines: MarkLineConfig[] = [
    { yAxis: 0, color: '#9ca3af', type: 'dashed' },
  ];
  const fuelTrimMarkAreas: MarkAreaConfig[] = [
    { yFrom: -10, yTo: 10, color: 'rgba(0,153,153,0.15)' },
  ];

  // Check which panels should render (conditional PIDs)
  const showBoostMaf = hasPids(['kff1278', 'k10'], available);
  const showThrottlePedal = hasPids(['k11', 'k49'], available);

  return (
    <div className="space-y-3">
      {/* Panel 1: Engine RPM & Vehicle Speed */}
      <DiagnosticPanel
        title="Engine RPM & Vehicle Speed"
        frames={frames}
        pids={['engineRpm', 'vehicleSpeed']}
        yAxisOverrides={{
          0: {}, // RPM left
          1: {}, // Speed right
        }}
      />

      {/* Panel 2: Fuel Trims */}
      <DiagnosticPanel
        title="Fuel Trims"
        frames={frames}
        pids={['k6', 'k7']}
        computedSeries={[totalTrimSeries]}
        markLines={fuelTrimMarkLines}
        markAreas={fuelTrimMarkAreas}
      />

      {/* Panel 3: O2 Sensor & AFR */}
      <DiagnosticPanel
        title="O2 Sensor & AFR"
        frames={frames}
        pids={['kff1214', 'kff124d']}
        yAxisOverrides={{
          0: {}, // O2 Voltage left
          1: {}, // AFR right
        }}
      />

      {/* Panel 4: Engine Coolant Temp */}
      <DiagnosticPanel
        title="Engine Coolant Temp"
        frames={frames}
        pids={['k5']}
        yAxisOverrides={{
          0: { min: 60, max: 95 },
        }}
      />

      {/* Panel 5: Boost & MAF (conditional — only if PIDs exist) */}
      {showBoostMaf && (
        <DiagnosticPanel
          title="Boost & MAF"
          frames={frames}
          pids={['kff1278', 'k10']}
          yAxisOverrides={{
            0: {}, // Boost left
            1: {}, // MAF right
          }}
        />
      )}

      {/* Panel 6: Throttle & Pedal (conditional — only if both PIDs exist) */}
      {showThrottlePedal && (
        <DiagnosticPanel
          title="Throttle & Pedal"
          frames={frames}
          pids={['k11', 'k49']}
          // Both are %, single Y-axis — no overrides needed
        />
      )}
    </div>
  );
}
