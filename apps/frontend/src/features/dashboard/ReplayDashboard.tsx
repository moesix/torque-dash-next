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

import React, { useState, useMemo, useCallback, useRef } from 'react';
import { useParams } from 'react-router';
import { exportSessionCsv, getVehicles, reassignSessionVehicle } from '@/lib/api';
import type { AnalysisPanelHandle } from '@/components/ai/AnalysisPanel';
import type { Vehicle } from '@/lib/types';
import VehicleReassignDialog from '@/components/vehicles/VehicleReassignDialog';
import Skeleton from '@/components/ui/Skeleton';
import ErrorAlert from '@/components/ui/ErrorAlert';
import { usePlaybackStore } from '@/app/playbackStore';
import SessionSummaryCard from '@/components/charts/SessionSummaryCard';
import GpsTrackMap from '@/components/map/GpsTrackMap';
import PlaybackControls from './PlaybackControls';
import OverlayChart from '@/components/charts/OverlayChart';
import DiagnosticPanels from '@/components/charts/DiagnosticPanels';
import PidTogglePanel from '@/components/telemetry/PidTogglePanel';
import DecodedMetricsTable from '@/components/telemetry/DecodedMetricsTable';
import { getAvailableSeries, getSeriesData, coerceScalar } from '@/lib/pidDecode';
import { useSessionTelemetry } from './hooks/useSessionTelemetry';
import { usePidSelection } from './hooks/usePidSelection';
import NotesCard from '@/components/NotesCard';
import AnalysisConfirmDialog from '@/components/AnalysisConfirmDialog';

const AnalysisPanel = React.lazy(() => import('@/components/ai/AnalysisPanel'));

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
  const { session, frames, isLoading, error, truncated } = useSessionTelemetry(id);

  // ── State ──────────────────────────────────────────────────────────
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const analysisPanelRef = useRef<AnalysisPanelHandle>(null);
  const [showAnalysisConfirm, setShowAnalysisConfirm] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);

  // ── Computed values ────────────────────────────────────────────────
  const available = useMemo(
    () => getAvailableSeries(frames),
    [frames],
  );

  const {
    selectedPids,
    selectedSources,
    handleToggle,
    handleSelectAll,
    handleClear,
    handleReset,
  } = usePidSelection(available, id);

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
  const handleCursorMove = useCallback(
    (tsMs: number | null) => setCursorTime(tsMs),
    [setCursorTime],
  );

  const handleExpand = useCallback(() => {
    dialogRef.current?.showModal();
  }, []);

  const handleCollapse = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  function scrollToAnalysis() {
    const el = document.getElementById('ai-analysis-panel');
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Reset playback cursor when switching sessions.
  React.useEffect(() => {
    setCursorTime(null);
  }, [id, setCursorTime]);

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
  if (isLoading) {
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
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
              <Skeleton className="h-12 w-full" />
            </div>
          </div>
          <div className="lg:w-1/3">
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
              <div className="flex justify-around">
                <Skeleton className="h-20 w-20" />
                <Skeleton className="h-20 w-20" />
                <Skeleton className="h-20 w-20" />
              </div>
            </div>
          </div>
        </div>

        {/* Chart area skeleton */}
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
          <Skeleton className="h-4 w-24 mb-4" />
          <Skeleton className="h-64 w-full" />
        </div>

        {/* Map + Metrics skeleton */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
            <Skeleton className="h-4 w-24 mb-4" />
            <Skeleton className="h-48 w-full" />
          </div>
          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
            <Skeleton className="h-4 w-24 mb-4" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      </div>
    );
  }
  if (error || !session) {
    return (
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
        <ErrorAlert message="Session not found." />
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Slim session banner — not a full Card */}
      <div className="animate-slide-up rounded-lg bg-white px-4 py-3 shadow-xs dark:bg-[var(--bg-card)]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white font-display">
              {session.name || 'Session Replay'}
              {session.vehicleName && (
                <span className="ml-2 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  {session.vehicleName}
                </span>
              )}
            </h1>
            <p className="text-sm text-gray-500 dark:text-[var(--text-secondary)]">
              {session.startDate
                ? new Date(session.startDate).toLocaleString()
                : ''}
              {session.duration ? ` · ${session.duration}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAnalysisConfirm(true)}
              className="rounded p-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              title="AI-powered session analysis"
              aria-label="AI Analysis"
            >
              🤖 AI
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!id) return;
                setIsExporting(true);
                setExportError(null);
                try {
                  await exportSessionCsv(id);
                } catch (err) {
                  setExportError(err instanceof Error ? err.message : 'Download failed');
                } finally {
                  setIsExporting(false);
                }
              }}
              disabled={isExporting}
              className="rounded p-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
              title="Download session data as CSV"
              aria-label="Download CSV"
            >
              {isExporting ? (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
              ) : (
                '↓ CSV'
              )}
            </button>
            {truncated && (
              <span
                className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-600/20 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-500/20"
                title="Session exceeds the 100k-frame fetch cap; later points are not shown"
              >
                Showing first 100k points
              </span>
            )}
            <button
              type="button"
              onClick={async () => {
                const v = await getVehicles();
                setVehicles(v ?? []);
                setShowReassign(true);
              }}
              className="rounded p-1.5 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              title="Reassign to a different vehicle"
            >
              🚗
            </button>
            {exportError && (
              <span className="text-xs text-red-500">{exportError}</span>
            )}
          </div>
        </div>
      </div>

      {/* Session notes */}
      {id && <NotesCard sessionId={id} initialNotes={session.notes ?? ''} />}

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
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
          <h3 className="text-lg font-semibold leading-relaxed">Metrics</h3>
          <PidTogglePanel
            available={available}
            selected={selectedPids}
            onToggle={handleToggle}
            onSelectAll={handleSelectAll}
            onClear={handleClear}
            onReset={handleReset}
          />
        </div>
        <DecodedMetricsTable sources={available} seriesData={allSeriesData} />
      </div>

      {/* Time Series — full width */}
      <div className="animate-slide-up-delay-3">
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold leading-relaxed">Time Series</h3>
            <button
              type="button"
              onClick={handleExpand}
              className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              aria-label="Expand chart"
            >
              ↑
            </button>
          </div>
          <OverlayChart
            frames={frames}
            sources={selectedSources}
            cursorTime={cursorTime}
            onCursorMove={handleCursorMove}
          />
        </div>

        <dialog
          ref={dialogRef}
          closedby="any"
          className="fixed inset-0 z-50 m-0 h-full w-full overflow-hidden bg-[var(--bg-base)] p-0 backdrop:bg-black/60 backdrop:backdrop-blur-sm"
          aria-label="Expanded chart"
          onClose={handleCollapse}
        >
          <div className="h-full rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold leading-relaxed">Time Series</h3>
              <button
                type="button"
                onClick={handleCollapse}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                aria-label="Collapse chart"
              >
                ↓
              </button>
            </div>
            <OverlayChart
              frames={frames}
              sources={selectedSources}
              cursorTime={cursorTime}
              onCursorMove={handleCursorMove}
              className="h-full"
            />
          </div>
        </dialog>
      </div>

      {/* ── Pre-configured diagnostic panels ────────────── */}
      <div className="animate-slide-up-delay-3">
        <DiagnosticPanels frames={frames} available={available} />
      </div>

      {/* GPS Track — full width */}
      <div className="animate-slide-up-delay-4">
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
          <h3 className="text-lg font-semibold leading-relaxed">GPS Track</h3>
          <div className="mt-2">
            <GpsTrackMap frames={frames} />
          </div>
        </div>
      </div>

      {/* AI Analysis confirmation dialog */}
      <AnalysisConfirmDialog
        open={showAnalysisConfirm}
        onClose={() => setShowAnalysisConfirm(false)}
        onConfirm={() => {
          setShowAnalysisConfirm(false);
          scrollToAnalysis();
          analysisPanelRef.current?.triggerAnalysis();
        }}
        busy={false}
      />

      {/* Vehicle reassign dialog */}
      {showReassign && (
        <VehicleReassignDialog
          vehicles={vehicles}
          currentVehicleId={session.vehicleId}
          onReassign={async (vehicleId) => {
            if (!id) return;
            await reassignSessionVehicle(id, vehicleId);
            setShowReassign(false);
          }}
          onClose={() => setShowReassign(false)}
        />
      )}

      {/* AI Analysis panel — at the bottom */}
      <div id="ai-analysis-panel" className="animate-slide-up-delay-5">
        <React.Suspense fallback={<div className="text-sm text-gray-400 p-4">Loading analysis panel...</div>}>
          <AnalysisPanel ref={analysisPanelRef} sessionId={id as string} />
        </React.Suspense>
      </div>
    </div>
  );
}