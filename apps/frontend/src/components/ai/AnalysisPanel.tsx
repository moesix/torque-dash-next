import { useState, useEffect, useRef, useImperativeHandle, useCallback } from 'react';
import type { Ref } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { analyzeSession, listAnalyses, getSettings } from '@/lib/api';
import StreamRenderer from './StreamRenderer';
import type { Analysis, Settings } from '@/lib/types';
import { stripMarkdown } from '@/lib/utils';

export interface AnalysisPanelHandle {
  triggerAnalysis: () => void;
}

interface Props {
  sessionId: string;
  /** React 19: ref is a regular prop — no forwardRef wrapper needed. */
  ref?: Ref<AnalysisPanelHandle>;
}

export default function AnalysisPanel({ sessionId, ref }: Props) {
    const [llmSettings, setLlmSettings] = useState<Settings | null>(null);
    const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pastAnalyses, setPastAnalyses] = useState<Analysis[]>([]);
    const [copiedId, setCopiedId] = useState<number | null>(null);
    const [copiedTextId, setCopiedTextId] = useState<number | null>(null);
    const [copiedStream, setCopiedStream] = useState(false);
    const latestResponseRef = useRef('');
    const panelRef = useRef<HTMLDivElement>(null);

    const doAnalyze = useCallback(async () => {
      setAnalyzing(true);
      setError(null);
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
      getSettings()
        .then((s) => setLlmSettings(s ?? null))
        .catch(() => {});
    }, []);

    useEffect(() => {
      listAnalyses(sessionId)
        .then((rows) => setPastAnalyses(rows ?? []))
        .catch(() => {});
    }, [sessionId]);

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

    if (llmSettings && !llmSettings.hasLlmProvider) {
      return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
          <h3 className="text-lg font-semibold leading-relaxed">AI Analysis</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-[var(--text-muted)]">
            Configure an AI provider in{' '}
            <a href="/settings" className="text-indigo-600 hover:underline dark:text-indigo-400">
              Settings
            </a>{' '}
            to enable session analysis.
          </p>
        </div>
      );
    }

    return (
      <div ref={panelRef} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-6 shadow-xs">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold leading-relaxed">AI Analysis</h3>
          </div>

          {error && (
            <p className="text-sm leading-relaxed text-rose-600 dark:text-rose-400">{error}</p>
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
              />
            </div>
          )}

          {pastAnalyses.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm leading-relaxed font-medium">Past Analyses</p>
              {pastAnalyses.map((a) => (
                <details key={a.id} className="rounded border border-[var(--border-default)] p-3 dark:border-[var(--border-strong)]">
                  <summary className="cursor-pointer text-sm text-gray-600 dark:text-gray-400">
                    {a.provider}/{a.model} — {new Date(a.createdAt).toLocaleString()}
                  </summary>
                  <div className="flex justify-end mt-1 mb-1">
                    <button
                      type="button"
                      onClick={() => copyToClipboard(a.response, a.id)}
                      className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                      {copiedId === a.id ? 'Copied!' : 'Copy'}
                    </button>
                    <button
                      type="button"
                      onClick={() => copyAsPlainText(a.response, a.id)}
                      className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 ml-2"
                    >
                      {copiedTextId === a.id ? 'Copied!' : 'Copy Text'}
                    </button>
                  </div>
                  <div className="prose prose-sm dark:prose-invert max-w-none analysis-prose overflow-hidden">
                    {a.reasoning && (
                      <details className="mb-3">
                        <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">
                          Reasoning
                        </summary>
                        <div className="mt-2 text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap border-l-2 border-gray-300 dark:border-gray-600 pl-3">
                          {a.reasoning}
                        </div>
                      </details>
                    )}
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                    >
                      {a.response}
                    </Markdown>
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      </div>
    );
}

