/**
 * Multi-series overlay chart that renders selected telemetry sources on
 * shared time axis with per-unit-group y-axes.
 *
 * Architecture (required by spec):
 * - Data rebuild and markLine update are in SEPARATE effects.  MarkLine uses
 *   merge-mode (`notMerge: false`) so cursor hover never re-renders all data.
 * - No `torqueGroup` / `echarts.connect` — the GPS map uses imperative store
 *   subscription, so group sync is unnecessary.
 */

import { useEffect, useMemo, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { TelemetryFrame, SeriesSource } from '@/lib/types';
import { getSeriesData } from '@/lib/pidDecode';

// Tree-shaken ECharts build.
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

// ── Constants ────────────────────────────────────────────────────────────

const COLORS = [
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#d97706',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#06b6d4',
  '#84cc16',
];

// ── Props ────────────────────────────────────────────────────────────────

interface Props {
  frames: TelemetryFrame[];
  /** The currently-selected sources to plot. */
  sources: SeriesSource[];
  cursorTime: number | null;
  onCursorMove: (tsMs: number | null) => void;
}

// ── Component ────────────────────────────────────────────────────────────

export default function OverlayChart({
  frames,
  sources,
  cursorTime,
  onCursorMove,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);

  // ── Group sources by unit → y-axis map ─────────────────────────────
  const { unitGroups, yAxisIndexMap } = useMemo(() => {
    const ug = new Map<string, SeriesSource[]>();
    const yMap = new Map<string, number>();
    let idx = 0;
    for (const s of sources) {
      const u = s.unit || '_';
      if (!ug.has(u)) {
        ug.set(u, []);
        yMap.set(u, idx);
        idx++;
      }
      ug.get(u)!.push(s);
    }
    return { unitGroups: ug, yAxisIndexMap: yMap };
  }, [sources]);

  // ── Init: create chart instance, wire events, resize ───────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = echarts.init(el);
    chartRef.current = chart;

    // Forward axis-pointer moves to parent
    // TODO: type params as echarts.UpdateAxisPointerParams
    chart.on('updateAxisPointer', (params: any) => {
      const axisValue = params?.axesInfo?.[0]?.axisValue;
      if (typeof axisValue === 'number') {
        onCursorMove(axisValue);
      }
    });

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [onCursorMove, sources.length]);

  // ── Data rebuild effect (non-merge: replaces everything) ───────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (sources.length === 0) {
      // Show placeholder — render an empty chart config so it stays mounted.
      chart.setOption(
        {
          animation: false,
          grid: { left: 56, right: 24, top: 24, bottom: 28 },
          xAxis: { type: 'time', show: true },
          yAxis: { type: 'value', show: false },
          series: [],
          tooltip: { show: false },
        },
        { notMerge: true },
      );
      return;
    }

    // Cap displayed axes to prevent chart area from shrinking to nothing.
    // Show at most 1 left + 3 right = 4 total. Rare unit groups are hidden
    // from axes but still visible in the tooltip.
    const MAX_AXES = 4;
    const unitEntries = Array.from(unitGroups.entries());

    // Sort by frequency (most common first) so we keep the most useful axes
    const unitFrequency = unitEntries.map(([unit, srcs]) => [unit, srcs.length] as const);
    unitFrequency.sort((a, b) => b[1] - a[1]);

    const visibleUnits = new Set(unitFrequency.slice(0, MAX_AXES).map(([u]) => u));
    const visibleAxisCount = visibleUnits.size;

    // Rebuild yAxisIndexMap only for visible units
    const visibleYAxisIndexMap = new Map<string, number>();
    let visibleIdx = 0;
    for (const [unit] of unitFrequency.slice(0, MAX_AXES)) {
      visibleYAxisIndexMap.set(unit, visibleIdx);
      visibleIdx++;
    }

    // Build yAxis options — one per visible unit group
    const yAxisOptions: any[] = [];
    let axisIdx = 0;
    for (const [unit] of unitFrequency.slice(0, MAX_AXES)) {
      const isFirst = axisIdx === 0;
      const opt: any = {
        type: 'value',
        name: unit === '_' ? '' : unit,
        nameLocation: 'middle',
        nameGap: 40,
        axisLabel: { fontSize: 10 },
      };
      if (isFirst) {
        opt.position = 'left';
      } else {
        opt.position = 'right';
        opt.offset = 45 * (axisIdx - 1);
        opt.splitLine = { show: false };
        // Only show label on the last right axis to reduce clutter
        opt.axisLabel = {
          ...opt.axisLabel,
          show: axisIdx === visibleAxisCount - 1,
        };
      }
      yAxisOptions.push(opt);
      axisIdx++;
    }

    // Grid — leave space for right-side offset axes, capped at 180px
    const rightMargin = Math.min(
      150,
      24 + Math.max(0, visibleAxisCount - 1) * 45,
    );

    // Build series options — hidden units still render, they just lack an axis
    const seriesOptions = sources.map((src, i) => {
      const u = src.unit || '_';
      const yi = visibleYAxisIndexMap.get(u) ?? 0;
      const color = COLORS[i % COLORS.length];
      const data = getSeriesData(frames, src);

      return {
        name: src.short,
        type: 'line' as const,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        data,
        yAxisIndex: yi,
        large: true,
        sampling: 'lttb' as const,
        // Initial markLine on first series (will be maintained by cursor effect)
        ...(i === 0
          ? {
              markLine: {
                symbol: 'none' as const,
                silent: true,
                data: [{ xAxis: cursorTime ?? 0 }],
                lineStyle: {
                  color: '#f43f5e',
                  type: 'solid' as const,
                  width: 1.5,
                },
                label: { show: false },
              },
            }
          : {}),
      };
    });

    chart.setOption(
      {
        animation: false,
        grid: { left: 56, right: rightMargin, top: 24, bottom: 28, containLabel: true },
        tooltip: { trigger: 'axis' as const },
        xAxis: { type: 'time' as const },
        yAxis: yAxisOptions,
        series: seriesOptions,
      },
      { notMerge: true },
    );
  }, [sources, frames, unitGroups, yAxisIndexMap]);

  // ── Cursor markLine effect (merge mode — does NOT re-render data) ──
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (sources.length === 0) return;

    if (cursorTime == null) {
      // Remove markLine
      chart.setOption(
        {
          series: [{ markLine: { data: [] } }],
        },
        { notMerge: false },
      );
    } else {
      chart.setOption(
        {
          series: [
            {
              markLine: {
                symbol: 'none',
                silent: true,
                data: [{ xAxis: cursorTime }],
                lineStyle: {
                  color: '#f43f5e',
                  type: 'solid',
                  width: 1.5,
                },
                label: { show: false },
              },
            },
            // Merge leaves other series untouched (each gets a fresh object)
            ...Array.from({ length: Math.max(0, sources.length - 1) }, () => ({})),
          ],
        },
        { notMerge: false },
      );
    }
  }, [cursorTime, sources.length]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div ref={containerRef} className="h-56 w-full lg:h-72">
      {sources.length === 0 && (
        <span className="flex h-full items-center justify-center text-sm text-gray-400">
          Select metrics to display
        </span>
      )}
    </div>
  );
}
