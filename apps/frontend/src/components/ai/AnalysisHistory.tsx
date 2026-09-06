import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { getAllAnalyses, getAnalysis, exportAnalyses, getVehicles, deleteAnalysis } from '@/lib/api';
import type { AnalysisPreview, Analysis, Vehicle } from '@/lib/types';

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
      }
    } catch {
      // Silently ignore
    } finally {
      setLoadingId(null);
    }
  }

  async function handleDeleteAnalysis(preview: AnalysisPreview) {
    // Cross-session rows carry the owning sessionId on the preview (the
    // listAllAnalyses endpoint selects it); the delete endpoint re-checks
    // ownership server-side regardless.
    const sessionId = preview.sessionId;
    if (sessionId == null) {
      setError('This analysis is missing its session and cannot be deleted.');
      return;
    }
    if (!confirm('Delete this analysis? This cannot be undone. Export or copy it first if you need to keep it.')) {
      return;
    }
    try {
      await deleteAnalysis(String(sessionId), preview.id);
      setError(null);
      setAnalyses((rows) => rows.filter((x) => x.id !== preview.id));
      setExpandedMap((prev) => {
        if (!prev.has(preview.id)) return prev;
        const next = new Map(prev);
        next.delete(preview.id);
        return next;
      });
      setTotal((t) => Math.max(0, t - 1));
      // If the deleted row was the last one on a non-first page, step back so
      // the list doesn't strand the user on an empty page.
      if (analyses.length === 1 && page > 0) {
        setPage((p) => p - 1);
      }
    } catch {
      setError('Failed to delete analysis.');
    }
  }

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold leading-relaxed">Analysis History</h3>
        <div className="flex items-center gap-2">
          <select
            value={vehicleFilter ?? ''}
            onChange={(e) => {
              setVehicleFilter(e.target.value ? Number(e.target.value) : undefined);
              setPage(0);
            }}
            className="rounded border bg-white px-2 py-1 text-sm dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
          >
            <option value="">All vehicles</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => exportAnalyses(vehicleFilter)}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 transition-colors dark:bg-indigo-500 dark:hover:bg-indigo-600"
          >
            Export Markdown
          </button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400 mb-4">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500 dark:text-[var(--text-muted)]">Loading...</p>
      ) : analyses.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-[var(--text-muted)]">
          No analyses found. Run an AI analysis on a session to get started.
        </p>
      ) : (
        <div className="space-y-2">
          {analyses.map((a) => {
            const full = expandedMap.get(a.id);
            const isLoading = loadingId === a.id;
            const sessionName = a.Session?.name || 'Unknown Session';
            const vehicleName = a.Session?.Vehicle?.name;

            return (
              <div
                key={a.id}
                className="rounded border border-[var(--border-default)] p-3 dark:border-[var(--border-strong)]"
              >
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => toggleExpand(a)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpand(a); }}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                      {sessionName}
                      {vehicleName && (
                        <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                          ({vehicleName})
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-[var(--text-muted)]">
                      {a.provider}/{a.model} — {new Date(a.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span className="flex shrink-0 items-center ml-2">
                    <button
                      type="button"
                      aria-label="Delete analysis"
                      onClick={(e) => {
                        // Stop the card's expand toggle (header click) from firing.
                        e.stopPropagation();
                        handleDeleteAnalysis(a);
                      }}
                      onKeyDown={(e) => {
                        // Enter/Space on the button must not reach the header's
                        // role="button" key handler and toggle the card.
                        e.stopPropagation();
                      }}
                      className="text-xs text-gray-500 hover:text-rose-600 dark:text-gray-400 dark:hover:text-rose-400 mr-3"
                    >
                      Delete
                    </button>
                    <span className="text-xs text-gray-400">
                      {isLoading ? '...' : full ? '−' : '+'}
                    </span>
                  </span>
                </div>

                {full && (
                  <div className="mt-3 border-t border-[var(--border-default)] pt-3">
                    <div className="prose prose-sm dark:prose-invert max-w-none analysis-prose overflow-hidden">
                      {full.reasoning && (
                        <details className="mb-3">
                          <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">
                            Reasoning
                          </summary>
                          <div className="mt-2 text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap border-l-2 border-gray-300 dark:border-gray-600 pl-3">
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
                  </div>
                )}
              </div>
            );
          })}

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="rounded border px-3 py-1 text-sm disabled:opacity-50 dark:border-[var(--border-default)]"
              >
                Previous
              </button>
              <span className="text-xs text-gray-500 dark:text-[var(--text-muted)]">
                Page {page + 1} of {totalPages} ({total} total)
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
                className="rounded border px-3 py-1 text-sm disabled:opacity-50 dark:border-[var(--border-default)]"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
