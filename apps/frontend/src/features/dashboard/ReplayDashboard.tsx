/**
 * Session replay dashboard — the primary telemetry-visualisation page.
 *
 * Shows playback controls, multi-series overlay chart, PID selection panel,
 * KPI cards, gauge tiles, GPS track map, and the decoded-metrics table.
 *
 * Architecture:
 * - `cursorTime` from the shared playback store syncs the overlay chart's
 *   markLine and the GPS map marker (imperative subscription in GpsTrackMap).
 * - Series data is built from the pidDecode engine; column sources
 *   (engineRpm, vehicleSpeed) are the defaults so the chart is never empty.
 * - Safe max computation (reduce loop) replaces the old spread-into-Math.max
 *   pattern that threw RangeError on large datasets.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { Card, Title } from '@tremor/react';
import { getSession, getTelemetry } from '@/lib/api';
import Skeleton from '@/components/ui/Skeleton';
import ErrorAlert from '@/components/ui/ErrorAlert';
import { usePlaybackStore } from '@/app/playbackStore';
import SessionSummaryCard from '@/components/charts/SessionSummaryCard';
import GpsTrackMap from '@/components/map/GpsTrackMap';
import PlaybackControls from './PlaybackControls';
import OverlayChart from '@/components/charts/OverlayChart';
import PidTogglePanel from '@/components/telemetry/PidTogglePanel';
import DecodedMetricsTable from '@/components/telemetry/DecodedMetricsTable';
import { getAvailableSeries, getSeriesData, coerceScalar } from '@/lib/pidDecode';
import type { SeriesSource } from '@/lib/types';

// ── Constants ────────────────────────────────────────────────────────────

/** Default selected source pids — these are column-based so the chart is
 *  never empty even when frames lack OBD-II PID values. */
const DEFAULT_PIDS = ['kc', 'vehicleSpeed', 'kff1007', 'k5', 'ke', 'kff1214'];

// ── Safe helpers ─────────────────────────────────────────────────────────

/**
 * Safe max computation — a simple reduce loop.
 * The old `Math.max(0, ...frames.map(...))` pattern throws RangeError when
 * the spread contains ~10k elements.
 */
function safeMax(values: (number | null)[]): number {
  let m = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && v > m) m = v;
  }
  return m;
}

// ── Component ────────────────────────────────────────────────────────────

export default function ReplayDashboard() {
  const { id } = useParams<{ id: string }>();
  const setCursorTime = usePlaybackStore((s) => s.setCursorTime);
  const cursorTime = usePlaybackStore((s) => s.cursorTime);

  // ── Data fetching ──────────────────────────────────────────────────
  const sessionQuery = useQuery({
    queryKey: ['session', id],
    queryFn: () => getSession(id as string),
    enabled: !!id,
  });

  const from = sessionQuery.data?.startDate;
  const to = sessionQuery.data?.endDate;

  const telemetryQuery = useQuery({
    queryKey: ['telemetry', id, from, to],
    queryFn: () => getTelemetry(id as string, from as string, to as string, 10000),
    enabled: !!id && !!from && !!to,
  });

  const frames = telemetryQuery.data ?? [];

  // ── State ──────────────────────────────────────────────────────────
  const [selectedPids, setSelectedPids] = useState<string[]>(DEFAULT_PIDS);
  const [chartExpanded, setChartExpanded] = useState(false);

  // ESC key handler + body scroll lock for expanded chart
  useEffect(() => {
    if (!chartExpanded) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChartExpanded(false);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', handleKey);
    };
  }, [chartExpanded]);

  // Reset playback cursor AND selected PIDs when switching sessions.
  useEffect(() => {
    setCursorTime(null);
    setSelectedPids(DEFAULT_PIDS);
  }, [id, setCursorTime]);

  // ── Computed values ────────────────────────────────────────────────
  const available: SeriesSource[] = useMemo(
    () => getAvailableSeries(frames),
    [frames],
  );

  const selectedSources = useMemo(
    () => available.filter((s) => selectedPids.includes(s.pid)),
    [available, selectedPids],
  );

  // Build series data for ALL available sources (used by DecodedMetricsTable).
  // Memoized — no re-scan of frames on re-render.
  const allSeriesData = useMemo(() => {
    const map = new Map<string, [number, number | null][]>();
    for (const src of available) {
      map.set(src.pid, getSeriesData(frames, src));
    }
    return map;
  }, [frames, available]);

  // ── Handlers ───────────────────────────────────────────────────────
  const handleToggle = useCallback((pid: string) => {
    setSelectedPids((prev) =>
      prev.includes(pid) ? prev.filter((p) => p !== pid) : [...prev, pid],
    );
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedPids(available.map((s) => s.pid));
  }, [available]);

  const handleClear = useCallback(() => {
    setSelectedPids([]);
  }, []);

  const handleReset = useCallback(() => {
    setSelectedPids(DEFAULT_PIDS);
  }, []);

  const handleCursorMove = useCallback(
    (tsMs: number | null) => setCursorTime(tsMs),
    [setCursorTime],
  );

  // ── Safe max for KPI cards (fixes RangeError bug) ─────────────────
  const maxRpm = useMemo(
    () => safeMax(frames.map((f) => coerceScalar(f.values?.kc))),
    [frames],
  );
  const maxSpeed = useMemo(
    () => safeMax(frames.map((f) => coerceScalar(f.vehicleSpeed))),
    [frames],
  );
  const maxCoolant = useMemo(
    () => safeMax(frames.map((f) => coerceScalar(f.values?.k5))),
    [frames],
  );

  // ── Loading / error states ─────────────────────────────────────────
  if (sessionQuery.isLoading) {
    return (
      <div className="space-y-4">
        {/* Slim banner skeleton */}
        <div className="rounded-lg bg-white px-4 py-3 shadow-xs dark:bg-[var(--bg-card)]">
          <Skeleton className="h-5 w-48 mb-1" />
          <Skeleton className="h-3 w-64" />
        </div>

        {/* Controls + Gauges skeleton */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="lg:w-2/3 self-start">
            <Card>
              <Skeleton className="h-12 w-full" />
            </Card>
          </div>
          <div className="lg:w-1/3">
            <Card>
              <div className="flex justify-around">
                <Skeleton className="h-20 w-20" />
                <Skeleton className="h-20 w-20" />
                <Skeleton className="h-20 w-20" />
              </div>
            </Card>
          </div>
        </div>

        {/* Chart area skeleton */}
        <Card>
          <Skeleton className="h-4 w-24 mb-4" />
          <Skeleton className="h-64 w-full" />
        </Card>

        {/* Map + Metrics skeleton */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <Skeleton className="h-4 w-24 mb-4" />
            <Skeleton className="h-48 w-full" />
          </Card>
          <Card>
            <Skeleton className="h-4 w-24 mb-4" />
            <Skeleton className="h-32 w-full" />
          </Card>
        </div>
      </div>
    );
  }
  if (sessionQuery.isError || !sessionQuery.data) {
    return (
      <Card>
        <ErrorAlert message="Session not found." />
      </Card>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Slim session banner — not a full Card */}
      <div className="animate-slide-up rounded-lg bg-white px-4 py-3 shadow-xs dark:bg-[var(--bg-card)]">
        <h1 className="text-lg font-semibold text-gray-900 dark:text-white font-display">
          {sessionQuery.data.name || 'Session Replay'}
        </h1>
        <p className="text-sm text-gray-500 dark:text-[var(--text-secondary)]">
          {sessionQuery.data.startDate
            ? new Date(sessionQuery.data.startDate).toLocaleString()
            : ''}
          {sessionQuery.data.duration ? ` · ${sessionQuery.data.duration}` : ''}
        </p>
      </div>

      {/* Playback controls — full width */}
      <div className="animate-slide-up-delay-1">
        <PlaybackControls frames={frames} />
      </div>

      {/* Session Summary + Metrics + Decoded Metrics — 3 equal columns */}
      <div className="animate-slide-up-delay-2 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SessionSummaryCard
          frames={frames}
          maxRpm={maxRpm}
          maxSpeed={maxSpeed}
          maxCoolant={maxCoolant}
        />
        <Card>
          <Title>Metrics</Title>
          <PidTogglePanel
            available={available}
            selected={selectedPids}
            onToggle={handleToggle}
            onSelectAll={handleSelectAll}
            onClear={handleClear}
            onReset={handleReset}
          />
        </Card>
        <DecodedMetricsTable sources={available} seriesData={allSeriesData} />
      </div>

      {/* Time Series — full width */}
      <div className="animate-slide-up-delay-3">
        {chartExpanded && (
          <div
            className="fixed inset-0 z-40 bg-black/50"
            onClick={() => setChartExpanded(false)}
            aria-hidden="true"
          />
        )}
        <div
          className={
            chartExpanded
              ? 'fixed inset-0 z-50 bg-white p-4 dark:bg-[var(--bg-card)]'
              : ''
          }
          role={chartExpanded ? 'dialog' : undefined}
          aria-modal={chartExpanded ? true : undefined}
          aria-label={chartExpanded ? 'Expanded time series chart' : undefined}
        >
          <Card className={chartExpanded ? 'h-full' : ''}>
            <div className="flex items-center justify-between">
              <Title>Time Series</Title>
              <button
                type="button"
                onClick={() => setChartExpanded((prev) => !prev)}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                aria-label={chartExpanded ? 'Collapse chart' : 'Expand chart'}
              >
                {chartExpanded ? '↓' : '↑'}
              </button>
            </div>
            <OverlayChart
              frames={frames}
              sources={selectedSources}
              cursorTime={cursorTime}
              onCursorMove={handleCursorMove}
              className={chartExpanded ? 'h-full' : undefined}
            />
          </Card>
        </div>
      </div>

      {/* GPS Track — full width */}
      <div className="animate-slide-up-delay-4">
        <Card>
          <Title>GPS Track</Title>
          {telemetryQuery.isLoading ? (
            <Skeleton className="mt-2 h-48 w-full" />
          ) : (
            <div className="mt-2">
              <GpsTrackMap frames={frames} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
