import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { getAllAnalyses, getAnalysis, exportAnalyses, getVehicles, deleteAnalysis, ApiError } from '@/lib/api';
import type { AnalysisPreview, Analysis, Vehicle } from '@/lib/types';
import Button from '@/components/ui/Button';
import ConfirmDialog from '@/components/ui/ConfirmDialog';
import ChevronIcon from '@/components/ui/ChevronIcon';
import Skeleton from '@/components/ui/Skeleton';

/**
 * Cross-vehicle analysis history — lists all analyses across sessions
 * with optional vehicle filtering, expand-to-detail, and markdown export.
 */
export default function AnalysisHistory() {
  const [analyses, setAnalyses] = useState<AnalysisPreview[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [limit] = useState(20);
  const [vehicleFilter, setVehicleFilter] = useState<number | undefined>(undefined);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [expandedMap, setExpandedMap] = useState<Map<number, Analysis>>(new Map());
  const [loadingId, setLoadingId] = useState<number | null>(null);
  // Rows whose body-fetch FAILED — an inline error + retry renders under the
  // collapsed summary (previously the failure was silently swallowed and the
  // row just stayed collapsed with no feedback).
  const [expandErrorIds, setExpandErrorIds] = useState<Set<number>>(new Set());
  // Rows with a delete in flight. A Set (not a single id slot) so row A's
  // completion can't re-enable row B's button while B is still deleting.
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
  // Delete confirmation target (replaces the native window.confirm).
  const [deleteTarget, setDeleteTarget] = useState<AnalysisPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load vehicles for filter dropdown
  useEffect(() => {
    getVehicles().then((v) => setVehicles(v ?? [])).catch(() => {});
  }, []);

  const fetchAnalyses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getAllAnalyses(limit, page * limit, vehicleFilter);
      if (res) {
        setAnalyses(res.analyses);
        setTotal(res.total);
      }
    } catch {
      setError('Failed to load analyses.');
    } finally {
      setLoading(false);
    }
  }, [limit, page, vehicleFilter]);

  useEffect(() => {
    fetchAnalyses();
  }, [fetchAnalyses]);

  async function toggleExpand(preview: AnalysisPreview) {
    if (expandedMap.has(preview.id)) {
      setExpandedMap((prev) => {
        const next = new Map(prev);
        next.delete(preview.id);
        return next;
      });
      return;
    }
    setLoadingId(preview.id);
    try {
      const full = await getAnalysis(preview.id);
      if (full) {
        setExpandedMap((prev) => new Map(prev).set(preview.id, full));
        setExpandErrorIds((ids) => {
          if (!ids.has(preview.id)) return ids;
          const next = new Set(ids);
          next.delete(preview.id);
          return next;
        });
      }
    } catch {
      // Surface an inline error + retry (was: silently ignored, leaving the
      // row collapsed with no feedback).
      setExpandErrorIds((ids) => new Set(ids).add(preview.id));
    } finally {
      setLoadingId(null);
    }
  }

  async function handleDeleteAnalysis(preview: AnalysisPreview) {
    // A delete is already in flight for this row — ignore the double-click
    // instead of firing a second DELETE that would 404 on the now-missing row.
    if (deletingIds.has(preview.id)) return;
    // Cross-session rows carry the owning sessionId on the preview (the
    // listAllAnalyses endpoint selects it); the delete endpoint re-checks
    // ownership server-side regardless.
    const sessionId = preview.sessionId;
    if (sessionId == null) {
      setError('This analysis is missing its session and cannot be deleted.');
      return;
    }
    setDeletingIds((ids) => new Set(ids).add(preview.id));
    setError(null);
    try {
      await deleteAnalysis(String(sessionId), preview.id);
      removeAnalysisLocally(preview);
      setTotal((t) => Math.max(0, t - 1));
      // If the deleted row was the last one on a non-first page, step back so
      // the list doesn't strand the user on an empty page.
      if (analyses.length === 1 && page > 0) {
        setPage((p) => p - 1);
      }
      // Success: close the dialog (mirrors VehicleManager's delete flow —
      // failures below keep it open instead, so the confirm can be retried
      // or cancelled; the title/body don't re-render while busy cycles).
      setDeleteTarget(null);
    } catch (err) {
      // A 404 means the row is ALREADY gone (e.g. the double-clicked second
      // DELETE, or another tab deleted it) — the desired end state is met,
      // so treat it as success rather than showing a spurious error.
      if (err instanceof ApiError && err.status === 404) {
        removeAnalysisLocally(preview);
        setTotal((t) => Math.max(0, t - 1));
        if (analyses.length === 1 && page > 0) {
          setPage((p) => p - 1);
        }
        setDeleteTarget(null);
      } else {
        // Real failure: keep the dialog open (VehicleManager parity — stay
        // open + busy-gated); `busy` clears below when the in-flight Set
        // entry drops, re-enabling Confirm/Cancel. The list's inline error
        // line (rendered behind the modal) still surfaces the failure.
        setError('Failed to delete analysis.');
      }
    } finally {
      setDeletingIds((ids) => {
        const next = new Set(ids);
        next.delete(preview.id);
        return next;
      });
    }
  }

  /** Drop a row from the local list and any expanded detail, no matter which
   *  delete path (success or already-deleted 404) reached the end state. */
  function removeAnalysisLocally(preview: AnalysisPreview) {
    setAnalyses((rows) => rows.filter((x) => x.id !== preview.id));
    setExpandedMap((prev) => {
      if (!prev.has(preview.id)) return prev;
      const next = new Map(prev);
      next.delete(preview.id);
      return next;
    });
    if (loadingId === preview.id) setLoadingId(null);
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold leading-relaxed">Analysis History</h3>
        <div className="flex items-center gap-2">
          <select
            value={vehicleFilter ?? ''}
            onChange={(e) => {
              setVehicleFilter(e.target.value ? Number(e.target.value) : undefined);
              setPage(0);
            }}
            className="rounded border border-border bg-surface-card px-2 py-1 text-sm text-fg"
          >
            <option value="">All vehicles</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
          <Button variant="primary" size="sm" onClick={() => exportAnalyses(vehicleFilter)}>
            Export Markdown
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400 mb-4">{error}</p>
      )}

      {loading ? (
        // Row-shaped skeletons (3×) — mirrors the collapsed row heights
        // instead of a bare "Loading..." string.
        <div className="space-y-2" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded border border-border p-3">
              <Skeleton className="h-4 w-56 max-w-full" />
              <Skeleton className="mt-2 h-3 w-40 max-w-full" />
            </div>
          ))}
        </div>
      ) : analyses.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No analyses found. Run an AI analysis on a session to get started.
        </p>
      ) : (
        <div className="space-y-2">
          {analyses.map((a) => {
            const full = expandedMap.get(a.id);
            const isLoading = loadingId === a.id;
            const expandFailed = expandErrorIds.has(a.id);
            const sessionName = a.Session?.name || 'Unknown Session';
            const vehicleName = a.Session?.Vehicle?.name;

            return (
              <details
                key={a.id}
                open={!!full}
                role="region"
                aria-label={`Analysis: ${sessionName}`}
                className="rounded border border-border p-3"
              >
                <summary
                  className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm text-fg-secondary"
                  onClick={(e) => {
                    // Fully-controlled disclosure: intercept the native
                    // toggle and drive expansion through toggleExpand so the
                    // (async) body fetch stays the single source of truth.
                    e.preventDefault();
                    toggleExpand(a);
                  }}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-fg">
                      {isLoading ? 'Loading…' : sessionName}
                      {vehicleName && (
                        <span className="ml-2 text-xs font-normal text-fg-muted">
                          ({vehicleName})
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-fg-muted">
                      {a.provider}/{a.model} — {new Date(a.createdAt).toLocaleString()}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      aria-label="Delete analysis"
                      disabled={deletingIds.has(a.id)}
                      aria-busy={deletingIds.has(a.id) || undefined}
                      onClick={(e) => {
                        // The delete lives INSIDE <summary>; keep the native
                        // summary toggle and this row's click handler from
                        // firing (interactive-in-interactive guard — same
                        // pattern AnalysisPanel uses).
                        e.preventDefault();
                        e.stopPropagation();
                        setDeleteTarget(a);
                      }}
                      onKeyDown={(e) => {
                        // Enter/Space on the button must not reach summary
                        // and toggle the row.
                        e.stopPropagation();
                      }}
                      className="text-xs text-fg-muted hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-50 disabled:cursor-wait"
                    >
                      {deletingIds.has(a.id) ? 'Deleting…' : 'Delete'}
                    </button>
                    {/* Real rotating chevron: a transform, not two swapped
                        glyphs (the old text swap kept a dead
                        `transition-transform` class that never animated). */}
                    <ChevronIcon
                      className={`h-4 w-4 shrink-0 text-fg-muted transition-transform duration-200 ${
                        full ? 'rotate-180' : 'rotate-0'
                      }`}
                    />
                  </span>
                </summary>

                {/* Failed body fetch: inline error + retry. */}
                {expandFailed && (
                  <p
                    className="mt-2 text-xs text-rose-600 dark:text-rose-400"
                    role="alert"
                  >
                    Couldn&rsquo;t load this analysis.
                    <button
                      type="button"
                      onClick={() => void toggleExpand(a)}
                      disabled={isLoading}
                      className="ml-2 font-medium underline hover:no-underline disabled:opacity-50"
                    >
                      Retry
                    </button>
                  </p>
                )}

                {full && (
                  <div className="mt-3 border-t border-border pt-3">
                    <div className="prose prose-sm dark:prose-invert max-w-none analysis-prose overflow-hidden">
                      {full.reasoning && (
                        <details className="mb-3">
                          <summary className="cursor-pointer text-xs text-fg-muted">
                            Reasoning
                          </summary>
                          <div className="mt-2 text-xs text-fg-secondary whitespace-pre-wrap border-l-2 border-border-strong pl-3">
                            {full.reasoning}
                          </div>
                        </details>
                      )}
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight]}
                      >
                        {full.response}
                      </Markdown>
                    </div>
                    {full.tokenUsage?.aborted === true && (
                      <p
                        className="mt-2 text-sm leading-relaxed text-amber-600 dark:text-amber-400"
                        role="alert"
                      >
                        Analysis was cut off before completion.
                      </p>
                    )}
                  </div>
                )}
              </details>
            );
          })}

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border border-border px-3 py-2 text-sm text-fg-secondary disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-xs text-fg-muted">
                Page {page + 1} of {totalPages} ({total} total)
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border border-border px-3 py-2 text-sm text-fg-secondary disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation — replaces the native window.confirm.
          busy mirrors VehicleManager's delete dialog: buttons disabled while
          a delete is in flight, dialog stays open on failure. */}
      {deleteTarget && (
        <ConfirmDialog
          open
          busy={deletingIds.size > 0}
          title="Delete analysis?"
          description="This cannot be undone. Export or copy it first if you need to keep it."
          confirmLabel="Delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            if (deleteTarget) void handleDeleteAnalysis(deleteTarget);
          }}
        />
      )}
    </div>
  );
}
