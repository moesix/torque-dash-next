// @vitest-environment jsdom
/**
 * Regression tests for SessionSummaryCard's cursor-frame resolution (MAJOR #5,
 * plan 113). The map-marker path gained a test for the unified EARLIER-frame
 * tie semantics, but nothing asserted that the summary-card GAUGES honor the
 * same rule on an exact tie.
 *
 * Contract under test, as implemented in SessionSummaryCard.tsx:
 *
 *   currentValues = useMemo(() => {
 *     ...
 *     const idx = findNearestFrameIndex(sortedTimestamps, cursorTime);  (L175)
 *     ...value comes from frames[idx]
 *   }, [cursorTime, ...])
 *
 * and findNearestFrameIndex (lib/pidDecode.ts:314) breaks an exact
 * equidistant tie toward the EARLIER frame (`diffPrev <= diffCurr` → lo-1).
 * So with frames at t=0 and t=10000 and a cursor at exactly 5000, the gauge
 * must read frame 0's values, NOT frame 1's.
 *
 * These tests are behavior-asserting: they mount the real component, drive
 * the global playback store (usePlaybackStore.setCursorTime — the same store
 * the scrubber writes, mirroring mapView.test.ts's approach to cursor state),
 * and assert on the visible gauge text (aria-label of the role="img" rings).
 * Store writes sit outside React's event system, so each is wrapped in act().
 *
 * The card renders pure SVG (no echarts), so the only stubs needed are the
 * browser-only globals the jsdom environment lacks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { usePlaybackStore } from '@/app/playbackStore';
import SessionSummaryCard from '@/components/charts/SessionSummaryCard';
import type { TelemetryFrame } from '@/lib/types';

/** Set the playback cursor and flush React's external-store update. */
function setCursor(t: number | null) {
  act(() => {
    usePlaybackStore.getState().setCursorTime(t);
  });
}

/** Gauge value echoed in the ring's aria-label, e.g. "Speed: 0 km/h" → 0. */
function gaugeValue(accessibleName: string): number {
  const img = screen.getByRole('img', { name: accessibleName });
  const label = img.getAttribute('aria-label')!;
  const parsed = /: (-?\d+)/.exec(label);
  if (parsed == null) throw new Error(`No numeric gauge value in aria-label: ${label}`);
  return Number(parsed[1]);
}

/** A frame for cursor-tie assertions on the Speed gauge: the values bag also
 *  feeds the other gauges (kc: 0 → RPM reads 0; k5: 80 → a real 80°C coolant
 *  reading), but the tests below never assert on RPM or Coolant. */
function speedFrame(timestamp: string, speed: number): TelemetryFrame {
  return {
    timestamp,
    lon: null,
    lat: null,
    values: { kc: 0, k5: 80 }, // kc: 0 → RPM gauge reads 0; k5: 80 gives Coolant a real reading — tests only assert Speed
    engineRpm: null,
    vehicleSpeed: speed,
  };
}

/** Frames that straddle the cursor: t=0 (speed 0) and t=10000ms (speed 100).
 *  A cursor at exactly halfway is equidistant — the EARLIER frame (index 0,
 *  0 km/h) must win under plan 113's unified semantics.
 *
 *  Cursors are REAL epoch-ms between the frame timestamps (the 2026-01-01T00:
 *  00:00.000Z baseline), NOT bare "5000"/"9000" — those lie in 1970, before
 *  every frame. */
const BASE_MS = new Date('2026-01-01T00:00:00.000Z').getTime();

function straddlingFrames(): TelemetryFrame[] {
  return [
    speedFrame('2026-01-01T00:00:00.000Z', 0),
    speedFrame('2026-01-01T00:00:10.000Z', 100),
  ];
}

function renderCard(frames: TelemetryFrame[]) {
  return render(
    <SessionSummaryCard frames={frames} maxRpm={8000} maxSpeed={240} maxCoolant={120} />,
  );
}

describe('SessionSummaryCard cursor tie-break (jsdom)', () => {
  beforeEach(() => {
    usePlaybackStore.setState({ cursorTime: null, isPlaying: false, speed: 1 });
  });

  afterEach(() => {
    usePlaybackStore.setState({ cursorTime: null, isPlaying: false, speed: 1 });
  });

  it('gauges read the EARLIER frame on an exact cursor tie (unified semantics)', () => {
    const frames = straddlingFrames();
    renderCard(frames);

    // Before any scrubbing the cursor is null → gauges read 0 (no current frame).
    expect(gaugeValue('Speed: 0 km/h')).toBe(0);

    // Park the cursor EXACTLY halfway between the two frames (BASE+5000ms).
    setCursor(BASE_MS + 5000);

    // The earlier frame (t=0, 0 km/h) must win the tie — the later frame's
    // 100 km/h reading must NOT surface here.
    expect(gaugeValue('Speed: 0 km/h')).toBe(0);
    expect(screen.queryByRole('img', { name: 'Speed: 100 km/h' })).toBeNull();
  });

  it('gauges read the LATER frame when the cursor is strictly nearer to it', () => {
    const frames = straddlingFrames();
    renderCard(frames);

    // BASE+9000ms is 1000ms from frame 1 vs 9000ms from frame 0 — unambiguous.
    setCursor(BASE_MS + 9000);

    expect(gaugeValue('Speed: 100 km/h')).toBe(100);
  });

  it('gauges read the EARLIER frame when the cursor is strictly nearer to it', () => {
    const frames = straddlingFrames();
    renderCard(frames);

    setCursor(BASE_MS + 1000);

    expect(gaugeValue('Speed: 0 km/h')).toBe(0);
    expect(screen.queryByRole('img', { name: 'Speed: 100 km/h' })).toBeNull();
  });

  it('gauges read the frame at an exact timestamp hit', () => {
    const frames = straddlingFrames();
    renderCard(frames);

    setCursor(BASE_MS + 10000);

    expect(gaugeValue('Speed: 100 km/h')).toBe(100);
  });
});
