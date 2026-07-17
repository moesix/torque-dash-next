import { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';

interface Props {
  stream: ReadableStream<Uint8Array>;
  onDone?: (fullText: string) => void;
  onError?: (error: string) => void;
}

export default function StreamRenderer({ stream, onDone, onError }: Props) {
  const [text, setText] = useState('');
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
    let fullText = '';

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
              setDone(true);
              onDoneRef.current?.(fullText);
              return;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) {
                onErrorRef.current?.(parsed.error);
                return;
              }
              if (parsed.text) {
                fullText += parsed.text;
                setText(fullText);
              }
            } catch {}
          }
        }
        setDone(true);
        onDoneRef.current?.(fullText);
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
  }, [stream]);

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <Markdown>{text}</Markdown>
      {!done && (
        <span className="inline-block h-4 w-2 animate-pulse bg-gray-400 dark:bg-gray-500" />
      )}
    </div>
  );
}
