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
import { useParams, Link } from 'react-router';
import type { AnalysisPanelHandle } from '@/components/ai/AnalysisPanel';
import VehicleReassignDialog from '@/components/vehicles/VehicleReassignDialog';
import Skeleton from '@/components/ui/Skeleton';
import ErrorAlert from '@/components/ui/ErrorAlert';
import Badge from '@/components/ui/Badge';
import { usePlaybackStore } from '@/app/playbackStore';
import SessionSummaryCard from '@/components/charts/SessionSummaryCard';
import GpsTrackMap from '@/components/map/GpsTrackMap';
import PlaybackControls from './PlaybackControls';
import OverlayChart from '@/components/charts/OverlayChart';
import DiagnosticPanels from '@/components/charts/DiagnosticPanels';
import PidTogglePanel from '@/components/telemetry/PidTogglePanel';
import DecodedMetricsTable from '@/components/telemetry/DecodedMetricsTable';
import { getAvailableSeries, getSeriesData, precomputeEpochs, coerceScalar } from '@/lib/pidDecode';
import { useSessionTelemetry } from './hooks/useSessionTelemetry';
import { usePidSelection } from './hooks/usePidSelection';
import { usePrintMode } from './hooks/usePrintMode';
import { useVehicleReassign } from './hooks/useVehicleReassign';
import { useSessionExport } from './hooks/useSessionExport';
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

// ── Playback-cursor bridge ────────────────────────────────────────────────

/**
 * Local playback-cursor bridge for the overlay charts.
 *
 * ReplayDashboard must NOT hold a whole-component `cursorTime` subscription:
 * the value changes up to 60×/s during playback and scrubbing, and a
 * dashboard-wide subscription would re-render every child on every tick
 * (banner, PID panel, metrics table, memoized DiagnosticPanels, GPS map, ...).
 * OverlayChart is props-driven for the cursor (its own store subscription is a
 * separate plan), so this small component owns the `cursorTime` subscription
 * and forwards it — only the two chart instances re-render per tick while
 * ReplayDashboard only re-renders when session/UI state actually changes.
 */
function OverlayChartWithCursor(
  props: Omit<React.ComponentProps<typeof OverlayChart>, 'cursorTime'>,
) {
  const cursorTime = usePlaybackStore((s) => s.cursorTime);
  return <OverlayChart {...props} cursorTime={cursorTime} />;
}

// ── Component ────────────────────────────────────────────────────────────

export default function ReplayDashboard() {
  const { id } = useParams<{ id: string }>();
  const setCursorTime = usePlaybackStore((s) => s.setCursorTime);

  // ── Data fetching ──────────────────────────────────────────────────
  const { session, frames, isLoading, error, truncated } = useSessionTelemetry(id);

  // ── State ──────────────────────────────────────────────────────────
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const analysisPanelRef = useRef<AnalysisPanelHandle>(null);
  const [showAnalysisConfirm, setShowAnalysisConfirm] = useState(false);
  // View mode: 'dash' is the default landing view; 'map' shows the
  // GPS track near-fullscreen with the playback transport beneath it.
  const [viewMode, setViewMode] = useState<'dash' | 'map'>('dash');

  // Feature state machines, each self-contained in ./hooks (plans/017).
  // Print-to-PDF: force-expand panels → double-rAF → window.print(), reset on
  // afterprint (regression net: __tests__/printFlow.test.tsx).
  const { printMode, isPrinting, handlePrint } = usePrintMode();
  // CSV download: isExporting spinner + inline exportError.
  const { isExporting, exportError, handleExport } = useSessionExport(id);
  // Vehicle reassign: vehicles list, dialog visibility, inline error.
  const {
    showReassign,
    vehicles,
    reassignError,
    setReassignError,
    openReassign,
    reassign,
    closeReassign,
  } = useVehicleReassign(id);

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

  // Parse frame timestamps ONCE per frames load: shared by the all-series
  // build below and by every OverlayChart (options rebuild on source/theme
  // change would otherwise re-parse every frame per selected series).
  const epochs = useMemo(() => precomputeEpochs(frames), [frames]);

  // Build series data for ALL available sources (used by DecodedMetricsTable).
  // Memoized — no re-scan of frames on re-render.
  const allSeriesData = useMemo(() => {
    const map = new Map<string, [number, number | null][]>();
    for (const src of available) {
      map.set(src.pid, getSeriesData(frames, src, epochs));
    }
    return map;
  }, [frames, available, epochs]);

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

  // Safari fallback for the chart-expand dialog's light dismiss. fullscreen
  // dialogs (<dialog open>) don't light-dismiss on older engines the way
  // closedby="any" does; a click landing on the dialog element itself —
  // i.e. the backdrop/margin area — collapses it. Unlike the padded
  // AnalysisConfirmDialog there is NO rect hit-test here: this dialog is
  // full-bleed (fixed inset-0, h-full w-full) so it covers the viewport and
  // its rect contains every click — a rect containment test would suppress
  // ALL outside clicks. target === dialog can still only mean
  // "not on content" because the content lives in the inner <div
  // class="h-full card"> child. Checks dialog.open per event so a single
  // listener covers open/close cycles.
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if ('closedBy' in HTMLDialogElement.prototype) return;

    const handleClick = (e: MouseEvent) => {
      if (e.target !== dialog || !dialog.open) return;
      // Fullscreen dialog (see above): target === dialog is already the
      // "click missed the content" signal — close unconditionally.
      handleCollapse();
    };
    dialog.addEventListener('click', handleClick);
    return () => dialog.removeEventListener('click', handleClick);
  }, [handleCollapse]);

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
        <div className="rounded-lg bg-surface-card px-4 py-3 shadow-xs">
          <Skeleton className="h-5 w-48 mb-1" />
          <Skeleton className="h-3 w-64" />
        </div>

        {/* Note: this mirrors the loaded layout (three equal columns below,
            wide controls row above) with the same grid so skeletons don't
            shift content (CLS) when real data swaps in. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <div className="card lg:col-span-2">
            <Skeleton className="h-64 w-full" />
          </div>
          <div className="card">
            <Skeleton className="mb-3 h-5 w-40" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-4/6" />
            </div>
          </div>
          <div className="card lg:col-span-2">
            <Skeleton className="mb-4 h-4 w-24" />
            <Skeleton className="h-64 w-full" />
          </div>
          <div className="card">
            <Skeleton className="mb-4 h-4 w-24" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>

        {/* AI analysis skeleton */}
        <div className="card">
          <Skeleton className="mb-4 h-5 w-32" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }
  if (error || !session) {
    return (
      <div className="card">
        <ErrorAlert message="Session not found." />
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Slim session banner — not a full Card */}
      <div className="animate-slide-up rounded-lg bg-surface-card px-4 py-3 shadow-xs">
        {/* Back affordance — replay is one page deep from the sessions list.
            Hidden in print so the PDF report keeps its clean title-only
            banner. */}
        <Link
          to="/"
          className="print:hidden inline-flex min-h-[44px] items-center rounded-md px-1 font-medium text-fg-muted transition-colors hover:text-fg"
        >
          ← All sessions
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-fg font-display">
              {session.name || 'Session Replay'}
              {session.vehicleName && (
                <Badge tone="neutral" className="ml-2">
                  {session.vehicleName}
                </Badge>
              )}
            </h1>
            <p className="text-sm text-fg-secondary">
              {session.startDate
                ? new Date(session.startDate).toLocaleString()
                : ''}
              {session.duration ? ` · ${session.duration}` : ''}
            </p>
          </div>
          {/* Right action cluster — allow wrapping onto its own line(s) at
              narrow viewports; hidden entirely when printing the report. */}
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <div
              role="group"
              aria-label="Session view mode"
              className="flex items-center whitespace-nowrap rounded-lg border border-gray-200 p-0.5 dark:border-[var(--border-strong)] print:hidden"
            >
              <span className="mr-1 text-xs text-fg-muted">View:</span>
              {(['dash', 'map'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  aria-pressed={viewMode === mode}
                  aria-label={mode === 'dash' ? 'Dashboard view' : 'Map view'}
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium capitalize min-h-[40px] ${
                    viewMode === mode
                      ? 'bg-gray-900 text-white dark:bg-[var(--bg-elevated)] dark:text-white'
                      : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowAnalysisConfirm(true)}
              className="whitespace-nowrap rounded p-2.5 min-w-[44px] min-h-[44px] text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              title="AI-powered session analysis"
              aria-label="Run AI Analysis"
            >
              🤖 Run AI Analysis
            </button>
            <button
              type="button"
              onClick={handleExport}
              disabled={isExporting}
              className="whitespace-nowrap rounded p-2.5 min-w-[44px] min-h-[44px] text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
              title="Download session data as CSV"
              aria-label="Download CSV"
            >
              {isExporting ? (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
              ) : (
                '↓ CSV'
              )}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={isPrinting || viewMode === 'map'}
              className="whitespace-nowrap rounded p-2.5 min-w-[44px] min-h-[44px] text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
              title={
                viewMode === 'map'
                  ? 'Switch to Dash view to print the report'
                  : 'Print session report or save as PDF'
              }
              aria-label="Print session report"
            >
              {isPrinting ? (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
              ) : (
                '🖨️ Print / PDF'
              )}
            </button>
            {truncated && (
              <Badge
                tone="warn"
                title="Session exceeds the 100k-frame fetch cap; later points are not shown"
              >
                Showing first 100k points
              </Badge>
            )}
            <button
              type="button"
              onClick={openReassign}
              className="whitespace-nowrap rounded p-2.5 min-w-[44px] min-h-[44px] text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              title="Reassign to a different vehicle"
            >
              🚗
            </button>
            {exportError && (
              <span className="text-xs text-red-500">{exportError}</span>
            )}
            {!showReassign && reassignError && (
              <span className="text-xs text-red-500">{reassignError}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Dash (default) vs Map view body ───────────────────────── */}
      {viewMode === 'dash' ? (
        <>
      {/* Session notes */}
      {id && <NotesCard sessionId={id} initialNotes={session.notes ?? ''} />}

      {/* Playback controls — full width */}
      <div className="animate-slide-up-delay-1">
        <PlaybackControls frames={frames} />
      </div>

      {/* Session Summary + Metrics + Decoded Metrics — 3 equal columns */}
      <div className="animate-slide-up-delay-2 grid grid-cols-1 md:grid-cols-2 gap-4 lg:grid-cols-3">
        <SessionSummaryCard
          frames={frames}
          maxRpm={maxRpm}
          maxSpeed={maxSpeed}
          maxCoolant={maxCoolant}
        />
        <div className="card">
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
        <div className="card">
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
          <OverlayChartWithCursor
            frames={frames}
            sources={selectedSources}
            epochs={epochs}
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
          <div className="h-full card">
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
            <OverlayChartWithCursor
              frames={frames}
              sources={selectedSources}
              epochs={epochs}
              onCursorMove={handleCursorMove}
              className="h-full"
            />
          </div>
        </dialog>
      </div>

      {/* ── Pre-configured diagnostic panels ────────────── */}
      <div className="animate-slide-up-delay-3">
        <DiagnosticPanels
          frames={frames}
          available={available}
          forceExpanded={printMode}
        />
      </div>

      {/* GPS Track — full width */}
      <div className="animate-slide-up-delay-4">
        <div className="card">
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
        busy={analysisPanelRef.current?.isAnalyzing() ?? false}
      />

      {/* Vehicle reassign dialog */}
      {showReassign && (
        <VehicleReassignDialog
          vehicles={vehicles}
          currentVehicleId={session.vehicleId}
          onReassign={reassign}
          onError={setReassignError}
          onClose={closeReassign}
        />
      )}

      {/* AI Analysis panel — at the bottom */}
      <div id="ai-analysis-panel" className="animate-slide-up-delay-5">
        <React.Suspense
          fallback={
            <div className="card" aria-busy="true">
              <div className="print:hidden">
                <Skeleton className="mb-4 h-5 w-32" />
                <Skeleton className="h-24 w-full" />
              </div>
            </div>
          }
        >
          <AnalysisPanel
            ref={analysisPanelRef}
            sessionId={id as string}
            printMode={printMode}
          />
        </React.Suspense>
      </div>
        </>
      ) : (
        <div className="space-y-4">
          <div className="animate-slide-up rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-2 shadow-xs">
            <GpsTrackMap frames={frames} className="h-[calc(100vh-16rem)] min-h-[420px]" />
            <div className="px-2 pb-2">
              <PlaybackControls frames={frames} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
