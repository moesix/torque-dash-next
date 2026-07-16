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
  DataZoomComponent,
  DataZoomSliderComponent,
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
  DataZoomComponent,
  DataZoomSliderComponent,
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
  /** Additional CSS classes merged with computed height class. */
  className?: string;
}

// ── Component ────────────────────────────────────────────────────────────

export default function OverlayChart({
  frames,
  sources,
  cursorTime,
  onCursorMove,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);

  // ── Group sources by unit ──────────────────────────────────────────
  const unitGroups = useMemo(() => {
    const ug = new Map<string, SeriesSource[]>();
    for (const s of sources) {
      const u = s.unit || '_';
      if (!ug.has(u)) ug.set(u, []);
      ug.get(u)!.push(s);
    }
    return ug;
  }, [sources]);

  // ── Dynamic height class based on source count ─────────────────────
  const heightClass = useMemo(() => {
    const n = sources.length;
    if (n === 0) return 'h-56 lg:h-72';
    if (n <= 2) return 'h-64 lg:h-80';
    if (n <= 5) return 'h-80 lg:h-96';
    return 'h-96 lg:h-[480px]';
  }, [sources.length]);

  const mergedClassName = [heightClass, className].filter(Boolean).join(' ');

  // ── Init: create chart instance, wire events, resize ───────────────
  // Only recreate the chart instance when transitioning between empty ↔ non-empty.
  const wasEmptyRef = useRef(sources.length === 0);
  useEffect(() => {
    const isEmpty = sources.length === 0;
    const transitioned = wasEmptyRef.current !== isEmpty;
    wasEmptyRef.current = isEmpty;

    // Skip recreation if no DOM swap needed and chart already exists
    if (!transitioned && chartRef.current) return;

    const el = containerRef.current;
    if (!el) return;

    // Dispose previous instance if any
    if (chartRef.current) {
      chartRef.current.dispose();
      chartRef.current = null;
    }

    const chart = echarts.init(el);
    chartRef.current = chart;

    // Forward axis-pointer moves to parent
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

    const containerWidth = containerRef.current?.clientWidth ?? 640;
    const isMobile = containerWidth < 640;

    if (sources.length === 0) {
      // Show placeholder — render an empty chart config so it stays mounted.
      chart.setOption(
        {
          animation: false,
          grid: { left: isMobile ? 32 : 56, right: 24, top: 24, bottom: 60 },
          xAxis: { type: 'time', show: true },
          yAxis: { type: 'value', show: false },
          series: [],
          tooltip: { show: false },
        },
        { notMerge: true },
      );
      return;
    }

    // Build ALL unit entries, sorted by frequency (most common first).
    const unitEntries = Array.from(unitGroups.entries());
    const unitFrequency = unitEntries.map(([unit, srcs]) => [unit, srcs.length] as const);
    unitFrequency.sort((a, b) => b[1] - a[1]);

    const axisCount = unitFrequency.length;

    // Smart axis offset: reduce spacing when many axes
    const axisOffset = axisCount >= 6 ? 32 : axisCount >= 5 ? 38 : 45;
    const mobileAxisOffset = Math.min(axisOffset, 28);
    const effectiveOffset = isMobile ? mobileAxisOffset : axisOffset;

    // Build yAxis options — one per unit group
    const yAxisOptions: any[] = [];
    let axisIdx = 0;
    for (const [unit] of unitFrequency) {
      const isFirst = axisIdx === 0;
      const isLast = axisIdx === axisCount - 1;
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
        opt.offset = effectiveOffset * (axisIdx - 1);
        opt.splitLine = { show: false };
        // When 5+ axes, show every-other label to reduce clutter
        if (axisCount >= 5) {
          opt.axisLabel = {
            ...opt.axisLabel,
            show: axisIdx % 2 === 0 || isLast,
          };
        } else {
          // Show only label on the last right axis
          opt.axisLabel = {
            ...opt.axisLabel,
            show: isLast,
          };
        }
      }
      yAxisOptions.push(opt);
      axisIdx++;
    }

    // Grid — leave space for right-side offset axes.
    // On mobile (<640px), use tighter margins to prevent chart area collapse.
    const rightMargin = Math.min(
      isMobile ? 90 : 180,
      24 + Math.max(0, axisCount - 1) * effectiveOffset,
    );

    // Build series options
    const seriesOptions = sources.map((src, i) => {
      const u = src.unit || '_';
      // Find yAxisIndex for this unit in the full frequency list
      const yi = unitFrequency.findIndex(([unit]) => unit === u);
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
        yAxisIndex: yi >= 0 ? yi : 0,
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
        grid: { left: isMobile ? 32 : 56, right: rightMargin, top: 24, bottom: 60, containLabel: true },
        tooltip: { trigger: 'axis' as const },
        xAxis: { type: 'time' as const },
        yAxis: yAxisOptions,
        dataZoom: [
          {
            type: 'inside' as const,
            filterMode: 'none' as const,
          },
          {
            type: 'slider' as const,
            filterMode: 'none' as const,
            height: 20,
            borderColor: 'transparent',
            backgroundColor: 'rgba(37,99,235,0.08)',
            fillerColor: 'rgba(37,99,235,0.15)',
            handleStyle: { color: '#2563eb' },
            textStyle: { color: '#6b7280', fontSize: 10 },
          },
        ],
        series: seriesOptions,
      },
      { notMerge: true },
    );
  }, [sources, frames, unitGroups]);

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
        className={`flex w-full items-center justify-center text-sm text-gray-400 ${mergedClassName}`}
      >
        <span>Select metrics to display</span>
      </div>
    );
  }

  return <div ref={containerRef} className={`w-full ${mergedClassName}`} />;
}
