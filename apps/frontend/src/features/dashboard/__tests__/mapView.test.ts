import { describe, it, expect, vi } from 'vitest';

/**
 * Pure frame-resolution tests for the GPS map's "cursor on entry" logic
 * (plan 094 Step 5). The suite runs in vitest's NODE environment (no jsdom),
 * so the DOM-bound Leaflet / react-leaflet modules that GpsTrackMap imports at
 * module scope are mocked — only the exported helper `resolveFrameAtCursor`
 * is exercised, never a mounted map. Modeled on the playback store suite at
 * src/app/__tests__/playbackStore.test.ts.
 */
vi.mock('leaflet', () => ({
  default: {
    icon: () => ({}),
    Marker: { prototype: { options: {} } },
  },
}));

vi.mock('react-leaflet', () => ({
  MapContainer: () => null,
  TileLayer: () => null,
  Polyline: () => null,
  Marker: () => null,
}));

import { resolveFrameAtCursor } from '@/components/map/GpsTrackMap';
import type { TelemetryFrame } from '@/lib/types';

function frame(
  timestamp: string,
  lat: number | null,
  lon: number | null,
): TelemetryFrame {
  return { timestamp, lat, lon, values: {}, engineRpm: null, vehicleSpeed: null };
}

describe('resolveFrameAtCursor', () => {
  const frames: TelemetryFrame[] = [
    frame('2026-01-01T00:00:00.000Z', 45.0, 7.0),
    frame('2026-01-01T00:00:10.000Z', 45.1, 7.1),
    frame('2026-01-01T00:00:20.000Z', 45.2, 7.2),
  ];
  const at = (iso: string) => new Date(iso).getTime();

  it('returns null for a null cursor (never scrubbed)', () => {
    expect(resolveFrameAtCursor(frames, null)).toBeNull();
  });

  it('returns the first frame when the cursor precedes it', () => {
    const f = resolveFrameAtCursor(frames, at('2025-12-31T23:59:50.000Z'));
    expect(f).not.toBeNull();
    expect(f!.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns the nearest frame for a cursor mid-route', () => {
    // Exact timestamp hit on the middle frame.
    expect(resolveFrameAtCursor(frames, at('2026-01-01T00:00:10.000Z'))!.timestamp).toBe(
      '2026-01-01T00:00:10.000Z',
    );
    // Between middle and last frame, nearer to the last.
    const near = resolveFrameAtCursor(frames, at('2026-01-01T00:00:16.000Z'));
    expect(near!.timestamp).toBe('2026-01-01T00:00:20.000Z');
  });

  it('pins to the EARLIER frame on an exact tie (unified cursor semantics)', () => {
    // 00:00:05 is exactly halfway between frame 0 and frame 1: the map
    // marker (and summary gauges) must agree on the EARLIER frame.
    const f = resolveFrameAtCursor(frames, at('2026-01-01T00:00:05.000Z'));
    expect(f).not.toBeNull();
    expect(f!.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null when the nearest frame has no coordinates', () => {
    const gpsless: TelemetryFrame[] = [
      frame('2026-01-01T00:00:00.000Z', null, null),
      frame('2026-01-01T00:00:10.000Z', null, null),
    ];
    expect(resolveFrameAtCursor(gpsless, at('2026-01-01T00:00:05.000Z'))).toBeNull();
  });
});
