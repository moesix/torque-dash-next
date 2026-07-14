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
import { Card, Grid, Text, Title } from '@tremor/react';
import { getSession, getTelemetry } from '@/lib/api';
import { usePlaybackStore } from '@/app/playbackStore';
import KpiCard from '@/components/charts/KpiCard';
import GaugeTile from '@/components/charts/GaugeTile';
import GpsTrackMap from '@/components/map/GpsTrackMap';
import PlaybackControls from './PlaybackControls';
import OverlayChart from '@/components/charts/OverlayChart';
import PidTogglePanel from '@/components/telemetry/PidTogglePanel';
import DecodedMetricsTable from '@/components/telemetry/DecodedMetricsTable';
import { getAvailableSeries, getSeriesData } from '@/lib/pidDecode';
import type { SeriesSource } from '@/lib/types';

// ── Constants ────────────────────────────────────────────────────────────

/** Default selected source pids — these are column-based so the chart is
 *  never empty even when frames lack OBD-II PID values. */
const DEFAULT_PIDS = ['engineRpm', 'vehicleSpeed', 'kff1007', 'k5', 'ke', 'kff1214'];

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
  const maxRpm = useMemo(() => safeMax(frames.map((f) => f.engineRpm)), [frames]);
  const maxSpeed = useMemo(
    () => safeMax(frames.map((f) => f.vehicleSpeed)),
    [frames],
  );

  // ── Loading / error states ─────────────────────────────────────────
  if (sessionQuery.isLoading) {
    return (
      <Card>
        <Text>Loading session…</Text>
      </Card>
    );
  }
  if (sessionQuery.isError || !sessionQuery.data) {
    return (
      <Card>
        <Text className="text-rose-600">Session not found.</Text>
      </Card>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Session header */}
      <Card>
        <Title>{sessionQuery.data.name || 'Session Replay'}</Title>
        <Text>
          {sessionQuery.data.startDate
            ? new Date(sessionQuery.data.startDate).toLocaleString()
            : ''}
          {sessionQuery.data.duration ? ` · ${sessionQuery.data.duration}` : ''}
        </Text>
      </Card>

      {/* Transport controls */}
      <PlaybackControls frames={frames} />

      {/* KPI cards + gauges */}
      <Grid numItemsLg={4} className="gap-4">
        <KpiCard title="Max RPM" value={Math.round(maxRpm)} />
        <KpiCard title="Max Speed" value={`${Math.round(maxSpeed)} km/h`} />
        <GaugeTile title="Peak RPM" value={maxRpm} max={8000} unit=" rpm" />
        <GaugeTile title="Peak Speed" value={maxSpeed} max={240} unit=" km/h" />
      </Grid>

      {/* Overlay chart + metric selector */}
      <Grid numItemsLg={3} className="gap-4">
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

      {/* GPS track map */}
      <Card>
        <Title>GPS Track</Title>
        {telemetryQuery.isLoading ? (
          <Text className="mt-2">Loading telemetry…</Text>
        ) : (
          <div className="mt-2">
            <GpsTrackMap frames={frames} />
          </div>
        )}
      </Card>

      {/* Decoded metrics table */}
      <DecodedMetricsTable sources={available} seriesData={allSeriesData} />
    </div>
  );
}
