import { useState, useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react';
import { Card, Title, Text } from '@tremor/react';
import Markdown from 'react-markdown';
import { analyzeSession, listAnalyses, getSettings } from '@/lib/api';
import StreamRenderer from './StreamRenderer';
import type { Analysis, Settings } from '@/lib/types';

export interface AnalysisPanelHandle {
  triggerAnalysis: () => void;
}

interface Props {
  sessionId: string;
}

const AnalysisPanel = forwardRef<AnalysisPanelHandle, Props>(
  ({ sessionId }, ref) => {
    const [llmSettings, setLlmSettings] = useState<Settings | null>(null);
    const [stream, setStream] = useState<ReadableStream<Uint8Array> | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pastAnalyses, setPastAnalyses] = useState<Analysis[]>([]);
    const [copiedId, setCopiedId] = useState<number | null>(null);
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
        .then((s) => setLlmSettings(s))
        .catch(() => {});
    }, []);

    useEffect(() => {
      listAnalyses(sessionId)
        .then(setPastAnalyses)
        .catch(() => {});
    }, [sessionId]);

    function handleDone(fullText: string) {
      setAnalyzing(false);
      latestResponseRef.current = fullText;
      listAnalyses(sessionId).then(setPastAnalyses).catch(() => {});
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
        <Card>
          <Title>AI Analysis</Title>
          <Text className="mt-2 text-sm text-gray-500 dark:text-[var(--text-muted)]">
            Configure an AI provider in{' '}
            <a href="/settings" className="text-indigo-600 hover:underline dark:text-indigo-400">
              Settings
            </a>{' '}
            to enable session analysis.
          </Text>
        </Card>
      );
    }

    return (
      <Card ref={panelRef}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Title>AI Analysis</Title>
          </div>

          {error && (
            <Text className="text-sm text-rose-600 dark:text-rose-400">{error}</Text>
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
              <Text className="text-sm font-medium">Past Analyses</Text>
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
                  </div>
                  <div className="prose prose-sm dark:prose-invert max-w-none">
                    <Markdown>{a.response}</Markdown>
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      </Card>
    );
  }
);

AnalysisPanel.displayName = 'AnalysisPanel';
export default AnalysisPanel;
