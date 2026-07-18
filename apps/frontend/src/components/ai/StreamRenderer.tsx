import { useState, useEffect, useRef, useCallback } from 'react';
import Markdown from 'react-markdown';

interface StreamEvent {
  type?: 'content' | 'reasoning';
  text: string;
}

interface Props {
  stream: ReadableStream<Uint8Array>;
  onDone?: (fullText: string) => void;
  onError?: (error: string) => void;
}

export default function StreamRenderer({ stream, onDone, onError }: Props) {
  const [contentText, setContentText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const [done, setDone] = useState(false);

  const contentRef = useRef('');
  const reasoningRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onDoneRef = useRef(onDone);
  const onErrorRef = useRef(onError);
  onDoneRef.current = onDone;
  onErrorRef.current = onError;

  const appendContent = useCallback((chunk: string) => {
    contentRef.current += chunk;
  }, []);

  const appendReasoning = useCallback((chunk: string) => {
    reasoningRef.current += chunk;
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      setContentText(contentRef.current);
      setReasoningText(reasoningRef.current);
    }, 100);
  }, []);

  const flushNow = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setContentText(contentRef.current);
    setReasoningText(reasoningRef.current);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    async function read() {
      try {
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          if (cancelled) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              flushNow();
              setDone(true);
              onDoneRef.current?.(contentRef.current);
              return;
            }
            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;
              if (parsed.error) {
                onErrorRef.current?.(parsed.error as string);
                return;
              }
              const event = parsed as unknown as StreamEvent;
              if (event.text) {
                if (event.type === 'reasoning') {
                  appendReasoning(event.text);
                } else {
                  appendContent(event.text);
                }
                scheduleFlush();
              }
            } catch {
              // Malformed SSE line — skip silently
            }
          }
        }
        flushNow();
        setDone(true);
        onDoneRef.current?.(contentRef.current);
      } catch (err) {
        if (!cancelled) {
          onErrorRef.current?.(err instanceof Error ? err.message : 'Stream failed');
        }
      }
    }

    read();
    return () => {
      cancelled = true;
      reader.cancel();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  const hasContent = contentText.length > 0;
  const hasReasoning = reasoningText.length > 0;

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      {hasReasoning && hasContent && (
        <details className="mb-4">
          <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
            Reasoning ({reasoningText.length} chars)
          </summary>
          <div className="mt-2 text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap border-l-2 border-gray-300 dark:border-gray-600 pl-3">
            {reasoningText}
          </div>
        </details>
      )}
      {hasContent ? (
        <Markdown>{contentText}</Markdown>
      ) : hasReasoning ? (
        <>
          <div className="mb-2 text-xs text-gray-500 dark:text-gray-400 italic">
            Model produced reasoning only (no content).
          </div>
          <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
            {reasoningText}
          </div>
        </>
      ) : null}
      {!done && (
        <span className="inline-block h-4 w-2 animate-pulse bg-gray-400 dark:bg-gray-500" />
      )}
    </div>
  );
}
