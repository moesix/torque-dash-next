// @vitest-environment jsdom
/**
 * StreamRenderer SSE parser (plans/012).
 *
 * StreamRenderer consumes the analysis endpoint's `text/event-stream` body
 * directly: lines of `data: <json>`, `data: [DONE]` as the terminator, and
 * `{ error }` as an in-band failure. Nothing mocked here — the component is
 * driven with a real ReadableStream carrying the exact byte framing
 * controllers/AnalysisController.js writes (`data: ${JSON.stringify(evt)}\n\n`),
 * so the suite fails if the two sides drift apart.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import StreamRenderer from '@/components/ai/StreamRenderer';

const encoder = new TextEncoder();

/** A stream that emits the given chunks, then closes. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe('StreamRenderer SSE parser (jsdom)', () => {
  it('accumulates content across chunks, including an event split mid-JSON', async () => {
    const onDone = vi.fn();
    // First event is deliberately cut inside its JSON payload — the parser's
    // line buffer must join the halves before parse.
    const stream = streamOf(
      'data: {"type":"content","text":"Tor',
      'que runs fine"}\n\ndata: {"type":"content","text":" at 1 Hz"}\n\n',
      'data: [DONE]\n\n',
    );

    render(<StreamRenderer stream={stream} onDone={onDone} />);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith('Torque runs fine at 1 Hz');
    expect(screen.getByText(/Torque runs fine at 1 Hz/)).toBeTruthy();
    // [DONE] also clears the "still streaming" caret.
    expect(document.querySelector('.animate-pulse')).toBeNull();
  });

  it('[DONE] terminates parsing: trailing events in the same chunk are ignored', async () => {
    const onDone = vi.fn();
    const onError = vi.fn();
    const stream = streamOf(
      sse({ type: 'content', text: 'kept' }) +
        'data: [DONE]\n\n' +
        sse({ type: 'content', text: 'after-done' }),
    );

    render(<StreamRenderer stream={stream} onDone={onDone} onError={onError} />);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onDone).toHaveBeenCalledWith('kept');
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByText(/after-done/)).toBeNull();
  });

  it('surfaces an in-band error event and does not fire onDone', async () => {
    const onDone = vi.fn();
    const onError = vi.fn();
    const stream = streamOf(
      sse({ type: 'content', text: 'partial' }),
      'data: {"error":"Provider rejected the key."}\n\n',
    );

    render(<StreamRenderer stream={stream} onDone={onDone} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Provider rejected the key.'));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('routes reasoning-only streams to the reasoning fallback, not content', async () => {
    const onDone = vi.fn();
    const stream = streamOf(
      sse({ type: 'reasoning', text: 'thinking it over' }),
      'data: [DONE]\n\n',
    );

    render(<StreamRenderer stream={stream} onDone={onDone} />);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    // onDone still receives the (empty) content accumulator.
    expect(onDone).toHaveBeenCalledWith('');
    expect(screen.getByText('Model produced reasoning only (no content).')).toBeTruthy();
    expect(screen.getByText('thinking it over')).toBeTruthy();
  });
});
