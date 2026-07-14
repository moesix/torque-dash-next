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
  // Track the last sources length so cursor effect knows when data was rebuilt.
  const sourcesLenRef = useRef(0);

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
  }, [onCursorMove]);

  // ── Data rebuild effect (non-merge: replaces everything) ───────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    sourcesLenRef.current = sources.length;

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

    const yAxisCount = unitGroups.size;

    // Build yAxis options — one per unit group
    // TODO: type as echarts.YAxisOption once typed helpers are extracted
    const yAxisOptions: any[] = [];
    let axisIdx = 0;
    for (const [unit] of unitGroups) {
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
        opt.offset = 60 * (axisIdx - 1);
        opt.splitLine = { show: false };
        // Only show label on the last right axis to reduce clutter
        opt.axisLabel = {
          ...opt.axisLabel,
          show: axisIdx === yAxisCount - 1,
        };
      }
      yAxisOptions.push(opt);
      axisIdx++;
    }

    // Grid — leave space for right-side offset axes
    const rightMargin = 24 + Math.max(0, yAxisCount - 1) * 60;

    // Build series options
    const seriesOptions = sources.map((src, i) => {
      const u = src.unit || '_';
      const yi = yAxisIndexMap.get(u) ?? 0;
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
        grid: { left: 56, right: rightMargin, top: 24, bottom: 28 },
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
  if (sources.length === 0) {
    return (
      <div
        ref={containerRef}
        style={{ width: '100%', height: 280 }}
        className="flex items-center justify-center text-sm text-gray-400"
      >
        <span>Select metrics to display</span>
      </div>
    );
  }

  return <div ref={containerRef} style={{ width: '100%', height: 280 }} />;
}
