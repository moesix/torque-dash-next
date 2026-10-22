import { describe, it, expect, vi } from 'vitest';

/**
 * Two test layers, both pure (the suite runs in vitest's NODE environment
 * with no jsdom, so DOM-bound Leaflet / react-leaflet modules that
 * GpsTrackMap imports at module scope are mocked — only pure exports are
 * exercised, never a mounted map. Modeled on the playback store suite at
 * src/app/__tests__/playbackStore.test.ts):
 *
 * 1. `resolveFrameAtCursor` — the GPS map's "cursor on entry" logic
 *    (plan 094 Step 5).
 * 2. The tile-provider model — CARTO → keyless standard-OSM graceful
 *    degradation: provider constants, theme URL resolution, the attribution
 *    swap, the `[data-map-provider]` attribute pairing with the dark-theme
 *    tile-pane filter in src/index.css, and the filter rule source.
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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TILE_ERROR_THRESHOLD,
  TILE_ERROR_WINDOW_MS,
  TILE_PROVIDERS,
  mapProviderAttribute,
  recordTileError,
  tileConfigFor,
  type TileErrorEntry,
} from '@/components/map/GpsTrackMap';
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

// ── Tile-provider model (CARTO → keyless OSM fallback) ───────────────────

describe('tile providers — carto default with themed urls', () => {
  it('starts on CARTO with light/dark theme variants and its attribution', () => {
    expect(TILE_PROVIDERS[0].id).toBe('carto');
    expect(TILE_PROVIDERS[0].themed).toBe(true);

    const light = tileConfigFor('carto', 'light');
    const dark = tileConfigFor('carto', 'dark');
    expect(light.url).toMatch(/basemaps\.cartocdn\.com\/light_all\//);
    expect(dark.url).toMatch(/basemaps\.cartocdn\.com\/dark_all\//);
    // The {theme} placeholder is always resolved away — Leaflet only knows
    // {s}/{z}/{x}/{y}/{r}.
    expect(light.url).not.toContain('{theme}');
    expect(dark.url).not.toContain('{theme}');

    expect(light.attribution).toContain('OpenStreetMap');
    expect(light.attribution).toContain('CARTO');
  });
});

describe('tile providers — tileerror burst flips to the keyless OSM fallback', () => {
  const err = (key: string, at: number): TileErrorEntry => ({ key, at });

  it('does NOT flip on a single transient tileerror', () => {
    const first = recordTileError([], 'a.png', 0);
    expect(first.tripped).toBe(false);

    const repeat = recordTileError(first.ledger, 'a.png', 1); // same tile again
    expect(repeat.tripped).toBe(false);
    expect(repeat.ledger).toHaveLength(1); // distinctness: repeats don't accumulate
  });

  it(`flips once ${TILE_ERROR_THRESHOLD} DISTINCT tiles fail inside the window`, () => {
    let step = recordTileError([], 'a.png', 0);
    step = recordTileError(step.ledger, 'b.png', 1_000);
    expect(step.tripped).toBe(false); // 2 < threshold

    step = recordTileError(step.ledger, 'c.png', 2_000);
    expect(step.tripped).toBe(true);
    expect(step.ledger).toHaveLength(TILE_ERROR_THRESHOLD);
  });

  it('requires the SAME window: stale failures are pruned and cannot trip', () => {
    // 0 / 6000 / 13600 with a 10_000ms window: the first error is stale by
    // the time the third fires, so only two remain — no flip.
    const spaced = recordTileError(
      recordTileError(recordTileError([], 'a.png', 0).ledger, 'b.png', 6_000).ledger,
      'c.png',
      13_600,
    );
    expect(spaced.tripped).toBe(false);
    expect(spaced.ledger).toHaveLength(2); // 'a.png' pruned with its timestamp

    // Inclusive window edge (10_000ms apart still counts as "inside").
    const atEdge = recordTileError(
      recordTileError(recordTileError([], 'a.png', 0).ledger, 'b.png', 1_000).ledger,
      'c.png',
      10_000,
    );
    expect(atEdge.tripped).toBe(true);
  });

  it('after a burst, the resolved config is the keyless OSM template', () => {
    // Ramp every frontend tile URL off cartocdn's API-key wall: the fallback
    // is standard OpenStreetMap raster — no key, no subdomain template.
    expect(TILE_PROVIDERS[1].id).toBe('osm');
    expect(TILE_PROVIDERS[1].themed).toBe(false);
    const osm = tileConfigFor('osm', 'dark');
    expect(osm.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(osm.attribution).toContain('OpenStreetMap');
    // Provider swap also swaps the attribution notice (TileLayer keyed
    // remount re-creates it) — no stale CARTO credit on OSM tiles.
    expect(osm.attribution).not.toContain('CARTO');
  });
});

describe('tile providers — data-map-provider attribute / dark filter pairing', () => {
  it('stamps the attribute ONLY on the osm fallback, in either theme', () => {
    // CARTO: attribute absent → the invert filter in index.css can never
    // apply to the themed CARTO basemap, even in dark mode.
    expect(mapProviderAttribute('carto')).toBeUndefined();
    // OSM: attribute present (theme-independent; the CSS scopes the filter
    // with `.dark`, so light-theme OSM tiles are left un-filtered).
    expect(mapProviderAttribute('osm')).toBe('osm');
  });

  it('index.css pairs the dark theme with the [data-map-provider="osm"] tile pane', () => {
    // Pure relevance guard: the filter must be scoped to `.leaflet-tile-pane`
    // under BOTH `.dark` and the osm attribute, so nothing else inverts.
    const css = readFileSync(
      resolve(__dirname, '../../../index.css'),
      'utf8',
    );
    expect(css).toMatch(
      /\.dark \[data-map-provider=['"]osm['"]\] \.leaflet-tile-pane \{/,
    );
    // Filter is wrapped across two lines in the stylesheet for readability
    // — compare whitespace-normalized.
    expect(css.replace(/\s+/g, ' ')).toContain(
      'invert(1) hue-rotate(180deg) brightness(0.92) contrast(0.9) saturate(0.7)',
    );
    expect(TILE_ERROR_WINDOW_MS).toBeGreaterThan(0);
  });
});
