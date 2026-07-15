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
import { Card, Grid, Title } from '@tremor/react';
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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 items-start">
          <div className="lg:col-span-2">
            <Card>
              <Skeleton className="h-12 w-full" />
            </Card>
          </div>
          <Card>
            <div className="flex justify-around">
              <Skeleton className="h-20 w-20" />
              <Skeleton className="h-20 w-20" />
              <Skeleton className="h-20 w-20" />
            </div>
          </Card>
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

      {/* Controls + Gauges row — side by side on lg */}
      <div className="animate-slide-up-delay-1 grid grid-cols-1 gap-4 lg:grid-cols-3 items-start">
        <div className="lg:col-span-2">
          <PlaybackControls frames={frames} />
        </div>
        <SessionSummaryCard
          frames={frames}
          maxRpm={maxRpm}
          maxSpeed={maxSpeed}
          maxCoolant={maxCoolant}
        />
      </div>

      {/* Overlay chart + metric selector */}
      <Grid numItemsLg={3} className="animate-slide-up-delay-2 gap-4">
        <Card className="lg:col-span-2">
          <Title>Time Series</Title>
          <OverlayChart
            frames={frames}
            sources={selectedSources}
            cursorTime={cursorTime}
            onCursorMove={handleCursorMove}
          />
        </Card>
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
      </Grid>

      {/* Map + Metrics row — side by side on lg */}
      <div className="animate-slide-up-delay-3 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <Title>GPS Track</Title>
          {telemetryQuery.isLoading ? (
            <Skeleton className="mt-2 h-48 w-full" />
          ) : (
            <div className="mt-2">
              <GpsTrackMap frames={frames} />
            </div>
          )}
        </Card>
        <DecodedMetricsTable sources={available} seriesData={allSeriesData} />
      </div>
    </div>
  );
}
