import { useState, useEffect, useRef } from 'react';
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

/**
 * Throttled state updater for streaming text.
 * Accumulates text in refs and flushes to state at most every `intervalMs`.
 * This avoids re-rendering on every SSE chunk during high-throughput streaming.
 */
function useThrottledFlush(intervalMs = 100) {
  const [contentText, setContentText] = useState('');
  const [reasoningText, setReasoningText] = useState('');
  const contentRef = useRef('');
  const reasoningRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Append to the content accumulator. */
  function appendContent(chunk: string) {
    contentRef.current += chunk;
  }

  /** Append to the reasoning accumulator. */
  function appendReasoning(chunk: string) {
    reasoningRef.current += chunk;
  }

  /** Schedule a state flush if one isn't already pending. */
  function scheduleFlush() {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      setContentText(contentRef.current);
      setReasoningText(reasoningRef.current);
    }, intervalMs);
  }

  /** Flush immediately — used on stream completion. */
  function flushNow() {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setContentText(contentRef.current);
    setReasoningText(reasoningRef.current);
  }

  /** Cleanup timer on unmount. */
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
      }
    };
  }, []);

  return {
    contentText,
    reasoningText,
    contentRef,
    reasoningRef,
    appendContent,
    appendReasoning,
    scheduleFlush,
    flushNow,
  };
}

export default function StreamRenderer({ stream, onDone, onError }: Props) {
  const {
    contentText,
    reasoningText,
    contentRef,
    reasoningRef,
    appendContent,
    appendReasoning,
    scheduleFlush,
    flushNow,
  } = useThrottledFlush(100);

  const [done, setDone] = useState(false);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const onDoneRef = useRef(onDone);
  const onErrorRef = useRef(onError);
  onDoneRef.current = onDone;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    const reader = stream.getReader();
    readerRef.current = reader;
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
              const parsed: StreamEvent = JSON.parse(data);
              if ((parsed as Record<string, unknown>).error) {
                onErrorRef.current?.((parsed as Record<string, unknown>).error as string);
                return;
              }
              if (parsed.text) {
                // Backward compat: if `type` is missing, treat as "content"
                if (parsed.type === 'reasoning') {
                  appendReasoning(parsed.text);
                } else {
                  appendContent(parsed.text);
                }
                scheduleFlush();
              }
            } catch {
              // Malformed SSE line — skip silently
            }
          }
        }
        // Stream ended without [DONE] sentinel
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
  }, [stream, appendContent, appendReasoning, scheduleFlush, flushNow]);

  // When only reasoning is received (content is empty), show reasoning as main content.
  // DeepSeek reasoning models often put everything in the reasoning field.
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
