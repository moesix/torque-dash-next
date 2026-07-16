import { useEffect } from 'react';
import type { ChangeEvent } from 'react';
import { Button, Card, Text } from '@tremor/react';
import { usePlaybackStore } from '@/app/playbackStore';
import type { TelemetryFrame } from '@/lib/types';

interface Props {
  frames: TelemetryFrame[];
}

/**
 * Playback transport: play/pause + scrubber + speed. Writes `cursorTime` into
 * the shared playback store. The animation loop reads the latest cursor from
 * the store directly (via getState) to avoid stale closures.
 */
export default function PlaybackControls({ frames }: Props) {
  const cursorTime = usePlaybackStore((s) => s.cursorTime);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const speed = usePlaybackStore((s) => s.speed);
  const setCursorTime = usePlaybackStore((s) => s.setCursorTime);
  const play = usePlaybackStore((s) => s.play);
  const pause = usePlaybackStore((s) => s.pause);
  const setSpeed = usePlaybackStore((s) => s.setSpeed);

  const start = frames.length ? new Date(frames[0].timestamp).getTime() : 0;
  const end = frames.length
    ? new Date(frames[frames.length - 1].timestamp).getTime()
    : 0;

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const cur = usePlaybackStore.getState().cursorTime ?? start;
      let next = cur + dt * speed;
      if (next >= end) {
        setCursorTime(end);
        pause();
        return;
      }
      setCursorTime(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, speed, start, end, setCursorTime, pause]);

  const onScrub = (e: ChangeEvent<HTMLInputElement>) => {
    setCursorTime(Number(e.target.value));
  };

  const span = end - start;
  const pct =
    span > 0 && cursorTime != null
      ? ((cursorTime - start) / span) * 100
      : 0;
  const cursorLabel =
    cursorTime != null ? new Date(cursorTime).toLocaleTimeString() : '—';

  return (
    <Card className="h-fit">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => (isPlaying ? pause() : play())}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center"
        >
          {isPlaying ? 'Pause' : 'Play'}
        </Button>
        <input
          type="range"
          min={start}
          max={end}
          step={1}
          value={cursorTime ?? start}
          onChange={onScrub}
          className="min-w-[200px] flex-1 h-10"
          aria-label="Playback scrubber"
        />
        <span className="w-24 text-right text-sm tabular-nums text-gray-600 dark:text-[var(--text-muted)]" aria-live="polite">
          {cursorLabel}
        </span>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm min-h-[44px] dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)]"
          aria-label="Playback speed"
        >
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
          <option value={8}>8×</option>
        </select>
      </div>
      <Text className="mt-2 text-xs text-gray-500 dark:text-[var(--text-muted)]">
        {pct.toFixed(1)}% through session
      </Text>
    </Card>
  );
}
