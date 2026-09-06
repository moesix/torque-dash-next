import { useState, useEffect, useRef, useMemo, useImperativeHandle, useCallback } from 'react';
import type { Ref } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { analyzeSession, listAnalyses, getAnalysis, getFullSettings } from '@/lib/api';
import { Link } from 'react-router';
import StreamRenderer from './StreamRenderer';
import type { Analysis, AnalysisPreview, Settings } from '@/lib/types';
import { stripMarkdown } from '@/lib/utils';

export interface AnalysisPanelHandle {
  triggerAnalysis: () => void;
}

interface Props {
  sessionId: string;
  /** React 19: ref is a regular prop — no forwardRef wrapper needed. */
  ref?: Ref<AnalysisPanelHandle>;
  /** Print mode: the latest past analysis is force-expanded (body fetched)
   *  so the printed report includes the full AI analysis markdown. */
  printMode?: boolean;
}

export default function AnalysisPanel({ sessionId, ref, printMode = false }: Props) {
    const [llmSettings, setLlmSettings] = useState<Settings | null>(null);
    const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [budgetWarning, setBudgetWarning] = useState<string | null>(null);
    const [pastAnalyses, setPastAnalyses] = useState<AnalysisPreview[]>([]);
    const [expandedMap, setExpandedMap] = useState<Map<number, Analysis>>(new Map());
    const [loadingId, setLoadingId] = useState<number | null>(null);
    const [copiedId, setCopiedId] = useState<number | null>(null);
    const [copiedTextId, setCopiedTextId] = useState<number | null>(null);
    const [copiedStream, setCopiedStream] = useState(false);
    const latestResponseRef = useRef('');
    const panelRef = useRef<HTMLDivElement>(null);

    const doAnalyze = useCallback(async () => {
      setAnalyzing(true);
      setError(null);
      setBudgetWarning(null);
      latestResponseRef.current = '';
      try {
        const body = await analyzeSession(sessionId);
        setStream(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Analysis failed');
        setAnalyzing(false);
      }
    }, [sessionId]);

    useImperativeHandle(ref, () => ({ triggerAnalysis: doAnalyze }), [doAnalyze]);

    useEffect(() => {
      getFullSettings()
        .then((s) => setLlmSettings(s ?? null))
        .catch(() => {});
    }, []);

    useEffect(() => {
      listAnalyses(sessionId)
        .then((rows) => setPastAnalyses(rows ?? []))
        .catch(() => {});
    }, [sessionId]);

    // Latest analysis id (max id — newest row regardless of list order)
    const latestId = useMemo(() => {
      if (pastAnalyses.length === 0) return null;
      return pastAnalyses.reduce((max, a) => (a.id > max.id ? a : max)).id;
    }, [pastAnalyses]);

    // Print mode: ensure the latest analysis is fetched + expanded so the
    // printed report carries the full markdown. Fetch is async — if it was
    // never expanded before, the first print may omit the body (one-print
    // latency); the analysis is usually already expanded when the owner
    // prints after reading.
    useEffect(() => {
      if (!printMode) return;
      if (latestId == null) return;
      if (expandedMap.has(latestId)) return;
      const latest = pastAnalyses.find((a) => a.id === latestId);
      if (latest) toggleExpand(latest);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [printMode, latestId]);

    function handleDone(fullText: string) {
      setAnalyzing(false);
      latestResponseRef.current = fullText;
      listAnalyses(sessionId).then((rows) => setPastAnalyses(rows ?? [])).catch(() => {});
    }

    async function copyAsPlainText(text: string, id?: number) {
      try {
        await navigator.clipboard.writeText(stripMarkdown(text));
        if (id !== undefined) {
          setCopiedTextId(id);
          setTimeout(() => setCopiedTextId(null), 2000);
        }
      } catch {}
    }

    async function copyToClipboard(text: string, id?: number) {
      try {
        await navigator.clipboard.writeText(text);
        if (id !== undefined) {
          setCopiedId(id);
          setTimeout(() => setCopiedId(null), 2000);
        } else {
          setCopiedStream(true);
          setTimeout(() => setCopiedStream(false), 2000);
        }
      } catch {
        // Fallback: ignore
      }
    }

    async function toggleExpand(preview: AnalysisPreview) {
      if (expandedMap.has(preview.id)) {
        // Collapse
        setExpandedMap((prev) => {
          const next = new Map(prev);
          next.delete(preview.id);
          return next;
        });
        return;
      }
      // Expand — fetch full detail
      setLoadingId(preview.id);
      try {
        const full = await getAnalysis(preview.id);
        if (full) {
          setExpandedMap((prev) => new Map(prev).set(preview.id, full));
        }
      } catch {
        // Silently ignore — keep collapsed
      } finally {
        setLoadingId(null);
      }
    }

    if (llmSettings && !llmSettings.hasLlmProvider) {
      return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 md:p-6 shadow-xs">
          <h3 className="text-lg font-semibold leading-relaxed">AI Analysis</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-[var(--text-muted)]">
            Configure an AI provider in{' '}
            <Link to="/settings" className="text-indigo-600 hover:underline dark:text-indigo-400">
              Settings
            </Link>{' '}
            to enable session analysis.
          </p>
        </div>
      );
    }

    return (
      <div ref={panelRef} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 md:p-6 shadow-xs">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold leading-relaxed">AI Analysis</h3>
          </div>

          {error && (
            <p className="text-sm leading-relaxed text-rose-600 dark:text-rose-400">{error}</p>
          )}

          {budgetWarning && (
            <p className="text-sm leading-relaxed text-amber-600 dark:text-amber-400" role="alert">{budgetWarning}</p>
          )}

          {stream && (
            <div className="rounded border border-[var(--border-default)] p-4 dark:border-[var(--border-strong)]">
              <div className="flex justify-end mb-2">
                <button
                  type="button"
                  onClick={() => copyToClipboard(latestResponseRef.current)}
                  className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  {copiedStream ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <StreamRenderer
                stream={stream}
                onDone={handleDone}
                onError={(e) => { setError(e); setAnalyzing(false); }}
                onWarning={(w) => setBudgetWarning(w || null)}
              />
            </div>
          )}

          {pastAnalyses.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm leading-relaxed font-medium">Past Analyses</p>
              {pastAnalyses.map((a) => {
                const full = expandedMap.get(a.id);
                const isLoading = loadingId === a.id;
                return (
                  <details
                    key={a.id}
                    open={!!full || (printMode && a.id === latestId)}
                    className="rounded border border-[var(--border-default)] p-3 dark:border-[var(--border-strong)]"
                  >
                    <summary
                      className="cursor-pointer text-sm text-gray-600 dark:text-gray-400"
                      onClick={(e) => {
                        e.preventDefault();
                        toggleExpand(a);
                      }}
                    >
                      {isLoading ? 'Loading...' : `${a.provider}/${a.model} — ${new Date(a.createdAt).toLocaleString()}`}
                    </summary>
                    {full && (
                      <>
                        <div className="flex justify-end mt-1 mb-1">
                          <button
                            type="button"
                            onClick={() => copyToClipboard(full.response, full.id)}
                            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                          >
                            {copiedId === full.id ? 'Copied!' : 'Copy'}
                          </button>
                          <button
                            type="button"
                            onClick={() => copyAsPlainText(full.response, full.id)}
                            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 ml-2"
                          >
                            {copiedTextId === full.id ? 'Copied!' : 'Copy Text'}
                          </button>
                        </div>
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
                      </>
                    )}
                  </details>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
}

