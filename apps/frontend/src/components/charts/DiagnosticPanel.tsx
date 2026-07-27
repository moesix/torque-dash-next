/**
 * Collapsible diagnostic panel — a self-contained ECharts chart wrapped in
 * a card with header (title + row count + chevron).
 *
 * Features:
 * - Lazy ECharts initialization (only when first expanded)
 * - Dual Y-axis support via ECharts `yAxis: [{}, {}]` config
 * - markLine and markArea at the SERIES level (not option-level)
 * - Computed series (e.g., Total Trim = STFT + LTFT)
 * - Dark mode compatible, matches OverlayChart styling
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  MarkAreaComponent,
  DataZoomComponent,
  DataZoomSliderComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { TelemetryFrame, SeriesSource } from '@/lib/types';
import { getSeriesData, getAvailableSeries } from '@/lib/pidDecode';

// Tree-shaken ECharts build — same as OverlayChart + MarkAreaComponent
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  MarkAreaComponent,
  DataZoomComponent,
  DataZoomSliderComponent,
  CanvasRenderer,
]);

// ── Types ────────────────────────────────────────────────────────────────

export interface ComputedSeries {
  label: string;
  color: string;
  /** Function that computes [timestamp, value][] from frames. */
  compute: (frames: TelemetryFrame[]) => [number, number | null][];
  yAxisIndex?: number;
}

export interface MarkLineConfig {
  yAxis: number;
  color?: string;
  type?: 'solid' | 'dashed' | 'dotted';
}

export interface MarkAreaConfig {
  yFrom: number;
  yTo: number;
  color?: string;
}

export interface DiagnosticPanelProps {
  title: string;
  frames: TelemetryFrame[];
  /** PID keys to plot — resolved internally against available series. */
  pids: string[];
  /** Computed series to overlay (e.g., Total Trim). */
  computedSeries?: ComputedSeries[];
  /** Reference lines (e.g., 0-line). */
  markLines?: MarkLineConfig[];
  /** Reference areas (e.g., ±10% band). */
  markAreas?: MarkAreaConfig[];
  /** Override Y-axis config per series index. */
  yAxisOverrides?: Record<number, { min?: number; max?: number }>;
  defaultCollapsed?: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Resolve a PID string to its SeriesSource from the full available list. */
function findSource(
  pid: string,
  allSources: SeriesSource[],
): SeriesSource | undefined {
  return allSources.find((s) => s.pid === pid);
}

// ── Component ────────────────────────────────────────────────────────────

export default function DiagnosticPanel({
  title,
  frames,
  pids,
  computedSeries,
  markLines,
  markAreas,
  yAxisOverrides,
  defaultCollapsed = true,
}: DiagnosticPanelProps) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const hasInitRef = useRef(false);

  // Resolve PIDs to sources once (memoized)
  const allSources = useMemo(() => getAvailableSeries(frames), [frames]);
  const resolvedSources = useMemo(() =>
    pids.map((pid) => findSource(pid, allSources)).filter((s): s is SeriesSource => s !== undefined),
    [pids, allSources]
  );

  // ── Lazy init: only create chart when first expanded ──────────────────
  useEffect(() => {
    if (!expanded || hasInitRef.current) return;

    const el = containerRef.current;
    if (!el) return;

    const chart = echarts.init(el);
    chartRef.current = chart;
    hasInitRef.current = true;

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
      hasInitRef.current = false;
    };
  }, [expanded]);

  // ── Data rebuild effect ──────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !expanded) return;

    const containerWidth = containerRef.current?.clientWidth ?? 640;
    const isMobile = containerWidth < 640;

    // Determine Y-axis count from yAxisOverrides (more entries = more axes)
    const overrideKeys = yAxisOverrides ? Object.keys(yAxisOverrides).length : 0;
    const axisCount = overrideKeys > 1 ? 2 : 1;

    // Build yAxis options
    const yAxisOptions: any[] = [];
    for (let i = 0; i < axisCount; i++) {
      const opt: any = {
        type: 'value',
        position: i === 0 ? 'left' : 'right',
        axisLabel: { fontSize: 10 },
      };
      const override = yAxisOverrides?.[i];
      if (override?.min !== undefined) opt.min = override.min;
      if (override?.max !== undefined) opt.max = override.max;
      if (i > 0) {
        opt.splitLine = { show: false };
        opt.offset = 45;
      }
      yAxisOptions.push(opt);
    }

    // Build series from resolved PIDs
    const seriesOptions: any[] = [];

    for (let i = 0; i < resolvedSources.length; i++) {
      const src = resolvedSources[i];
      const data = getSeriesData(frames, src);
      const color = src.unit === 'rpm' ? '#009999' : src.unit === 'km/h' ? '#f97316'
        : src.unit === 'V' ? '#16a34a' : src.unit === ':1' ? '#92400e'
        : src.unit === '°C' ? '#dc2626' : src.unit === 'psi' ? '#06b6d4'
        : ['#009999', '#16a34a', '#dc2626', '#d97706', '#8b5cf6', '#f97316'][i % 6];

      seriesOptions.push({
        name: src.short,
        type: 'line' as const,
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        data,
        yAxisIndex: Math.min(i, axisCount - 1),
        large: true,
        sampling: 'lttb' as const,
      });
    }

    // Add computed series
    if (computedSeries) {
      for (const cs of computedSeries) {
        const data = cs.compute(frames);
        const seriesObj: any = {
          name: cs.label,
          type: 'line' as const,
          showSymbol: false,
          smooth: false,
          lineStyle: { width: 2, color: cs.color },
          itemStyle: { color: cs.color },
          data,
          yAxisIndex: cs.yAxisIndex ?? 0,
          large: true,
          sampling: 'lttb' as const,
        };

        // Attach markLine at SERIES level
        if (markLines && markLines.length > 0) {
          seriesObj.markLine = {
            symbol: 'none',
            silent: true,
            data: markLines.map((ml) => ({
              yAxis: ml.yAxis,
            })),
            lineStyle: {
              color: markLines[0]?.color ?? '#9ca3af',
              type: markLines[0]?.type ?? 'dashed',
              width: 1,
            },
            label: { show: false },
          };
        }

        // Attach markArea at SERIES level
        if (markAreas && markAreas.length > 0) {
          seriesObj.markArea = {
            silent: true,
            itemStyle: {
              color: markAreas[0]?.color ?? 'rgba(0,153,153,0.15)',
            },
            data: markAreas.map((ma) => [
              { yAxis: ma.yFrom, name: 'lower' },
              { yAxis: ma.yTo, name: 'upper' },
            ]),
          };
        }

        seriesOptions.push(seriesObj);
      }
    }

    // Grid margins
    const rightMargin = isMobile ? 60 : 45 + (axisCount - 1) * 45;

    chart.setOption(
      {
        animation: false,
        grid: {
          left: isMobile ? 8 : 56,
          right: rightMargin,
          top: 24,
          bottom: 60,
          containLabel: true,
        },
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
            backgroundColor: 'rgba(0,153,153,0.08)',
            fillerColor: 'rgba(0,153,153,0.15)',
            handleStyle: { color: '#009999' },
            textStyle: { color: '#6b7280', fontSize: 10 },
          },
        ],
        series: seriesOptions,
      },
      { notMerge: true },
    );
  }, [
    expanded,
    frames,
    resolvedSources,
    computedSeries,
    markLines,
    markAreas,
    yAxisOverrides,
  ]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border-default)] bg-white dark:bg-[var(--bg-card)]">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-[var(--bg-surface)]"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            {title}
          </span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">
            {frames.length} rows
          </span>
        </div>
        <span className="text-gray-400 transition-transform duration-200 dark:text-gray-500">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {/* Chart body */}
      {expanded && (
        <div className="border-t border-[var(--border-default)] px-1 pb-2">
          {resolvedSources.length === 0 && !computedSeries?.length ? (
            <div className="flex h-48 items-center justify-center text-sm text-gray-400">
              No matching PIDs in this session
            </div>
          ) : (
            <div ref={containerRef} className="h-64 w-full lg:h-80" />
          )}
        </div>
      )}
    </div>
  );
}
