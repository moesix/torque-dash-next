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
 * 2. The tile-provider model — settings-driven resolution (keyless standard
 *    OSM is the DEFAULT; keyed CARTO is the opt-in admin upgrade) plus the
 *    tileerror burst degrade-to-OSM latch: provider constants, theme URL
 *    resolution, the key= query append, the attribution swap, the
 *    `[data-map-provider]` attribute pairing with the dark-theme tile-pane
 *    filter in src/index.css, and the filter rule source.
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
  resolveTileTargets,
  tileConfigFor,
  type AppTileSettings,
  type TileErrorEntry,
} from '@/components/map/GpsTrackMap';
import { resolveFrameAtCursor } from '@/components/map/GpsTrackMap';
import {
  decimatePositions,
  splitAntimeridian,
} from '@/components/map/GpsTrackMap';
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

// ── Static route geometry (decimation + antimeridian split) ──────────────

describe('decimatePositions', () => {
  const route = (n: number): [number, number][] =>
    Array.from({ length: n }, (_, i) => [10 + i * 0.0001, 7 + i * 0.0001]);

  it('bounds the vertex count at `max` and keeps both endpoints exact', () => {
    const positions = route(10_000);
    const decimated = decimatePositions(positions, 4_000);
    expect(decimated.length).toBeLessThanOrEqual(4_000);
    // Endpoints are the recording's real start/end — never sliced off.
    expect(decimated[0]).toEqual(positions[0]);
    expect(decimated[decimated.length - 1]).toEqual(positions[positions.length - 1]);
    // Order is preserved (no reordering/shuffling of the track).
    expect(decimated[1][0]).toBeGreaterThan(decimated[0][0]);
  });

  it('applies the default 4000-vertex budget', () => {
    expect(decimatePositions(route(100_000)).length).toBe(4_000);
  });

  it('leaves an already-small route untouched and handles empties', () => {
    const positions = route(3);
    expect(decimatePositions(positions, 4_000)).toBe(positions);
    expect(decimatePositions([])).toEqual([]);
  });
});

describe('splitAntimeridian', () => {
  it('splits a dateline crossing into two segments', () => {
    const segments = splitAntimeridian([
      [10, 179.9],
      [10, -179.9],
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual([[10, 179.9]]);
    expect(segments[1]).toEqual([[10, -179.9]]);
  });

  it('keeps an ordinary (non-dateline) track in ONE segment', () => {
    const positions: [number, number][] = [
      [45.0, 7.0],
      [45.1, 7.1],
      [45.2, 6.9],
    ];
    const segments = splitAntimeridian(positions);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual(positions);
  });

  it('returns no segments for an empty route and one for a single point', () => {
    expect(splitAntimeridian([])).toEqual([]);
    expect(splitAntimeridian([[1, 2]])).toEqual([[[1, 2]]]);
  });
});

// ── Tile-provider model (settings-driven: OSM default, CARTO opt-in) ──────

describe('tile providers — keyless OSM is the base; CARTO needs the {theme} route', () => {
  it('OSM is the default base provider (keyless, theme-independent)', () => {
    expect(TILE_PROVIDERS[0].id).toBe('osm');
    expect(TILE_PROVIDERS[0].themed).toBe(false);

    const osm = tileConfigFor('osm', 'dark');
    expect(osm.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(osm.attribution).toContain('OpenStreetMap');
    // No keyless provider should ever carry a CARTO credit on its tiles.
    expect(osm.attribution).not.toContain('CARTO');
  });

  it('CARTO is the opt-in provider with light/dark theme variants and attribution', () => {
    expect(TILE_PROVIDERS[1].id).toBe('carto');
    expect(TILE_PROVIDERS[1].themed).toBe(true);

    const light = tileConfigFor('carto', 'light');
    const dark = tileConfigFor('carto', 'dark');
    expect(light.url).toMatch(/basemaps\.cartocdn\.com\/light_all\//);
    expect(dark.url).toMatch(/basemaps\.cartocdn\.com\/dark_all\//);
    // The {theme} placeholder is always resolved away — Leaflet only knows
    // {s}/{z}/{x}/{y}/{r}. The BASE template is key-blind: the key
    // append lives in resolveTileTargets, so no key ever sits in
    // TILE_PROVIDERS.
    expect(light.url).not.toContain('{theme}');
    expect(dark.url).not.toContain('{theme}');
    expect(dark.url).not.toContain('key=');

    expect(light.attribution).toContain('OpenStreetMap');
    expect(light.attribution).toContain('CARTO');
  });
});

// ── resolveTileTargets: THE settings-driven resolution rule ──────────────

describe('resolveTileTargets — settings-driven provider resolution', () => {
  it('no settings at all (settings fetch failed/loading) resolves OSM, unkeyed', () => {
    const t = resolveTileTargets(undefined, 'light');
    expect(t.providerId).toBe('osm');
    expect(t.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(t.attribution).not.toContain('CARTO');
    expect(t.keyedStamp).toBe(false);
  });

  it('osm configured → osm always, unkeyed, whatever the stored fields', () => {
    const s: AppTileSettings = { tileProvider: 'osm', cartoApiKey: undefined };
    const t = resolveTileTargets(s, 'dark');
    expect(t.providerId).toBe('osm');
    expect(t.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(t.keyedStamp).toBe(false);
  });

  it('carto + key → carto with the documented key query param appended', () => {
    const s: AppTileSettings = { tileProvider: 'carto', cartoApiKey: 'abc123XYZ' };
    const light = resolveTileTargets(s, 'light');
    expect(light.providerId).toBe('carto');
    expect(light.url).toBe(
      'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=abc123XYZ',
    );
    expect(light.keyedStamp).toBe(true);
    expect(light.attribution).toContain('CARTO');

    const dark = resolveTileTargets(s, 'dark');
    expect(dark.url).toMatch(/basemaps\.cartocdn\.com\/dark_all\/\{z\}\/\{x\}\/\{y\}\{r\}\.png\?key=abc123XYZ/);
    expect(dark.keyedStamp).toBe(true);
  });

  it('carto + blank key resolves OSM (no keyless-carto request, no fallback latch needed)', () => {
    const blank: AppTileSettings = { tileProvider: 'carto', cartoApiKey: '' };
    const t = resolveTileTargets(blank, 'light');
    expect(t.providerId).toBe('osm');
    expect(t.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(t.url).not.toContain('key=');
    expect(t.keyedStamp).toBe(false);

    // Whitespace churn from any layer never counts as a key.
    const whitespace: AppTileSettings = { tileProvider: 'carto', cartoApiKey: '   ' };
    expect(resolveTileTargets(whitespace, 'light').providerId).toBe('osm');
  });

  it('keyedStamp is true exactly when the URL embeds the admin key (never logged)', () => {
    const keyed = resolveTileTargets(
      { tileProvider: 'carto', cartoApiKey: 'k' },
      'light',
    );
    const unkeyed = resolveTileTargets(undefined, 'light');
    expect(keyed.keyedStamp).toBe(true);
    expect(unkeyed.keyedStamp).toBe(false);
    // keyless resolution must not reference any vendor key param at all.
    expect(unkeyed.url).not.toContain('key=');
  });

  it('data-map-provider pairs with the EFFECTIVE provider in both directions', () => {
    // CARTO serving: attribute absent — the .dark invert filter can never
    // touch its real dark tiles.
    const carto = resolveTileTargets(
      { tileProvider: 'carto', cartoApiKey: 'k' },
      'light',
    );
    expect(mapProviderAttribute(carto.providerId)).toBeUndefined();
    // OSM serving (default, blank-key degrade, or burst fallback): attribute
    // 'osm' — the filter scopes on it.
    const osm = resolveTileTargets(undefined, 'light');
    expect(mapProviderAttribute(osm.providerId)).toBe('osm');
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
    // The burst-fallback target is the same keyless standard-OSM provider
    // the settings route resolves to — no key, no subdomain template.
    const t = resolveTileTargets(undefined, 'dark');
    expect(t.providerId).toBe('osm');
    expect(t.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(t.attribution).toContain('OpenStreetMap');
    // Provider swap also swaps the attribution notice (TileLayer keyed
    // remount re-creates it) — no stale CARTO credit on OSM tiles.
    expect(t.attribution).not.toContain('CARTO');
  });
});

describe('tile providers — data-map-provider attribute / dark filter pairing', () => {
  it('stamps the attribute ONLY on the effective osm provider, in either theme', () => {
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
