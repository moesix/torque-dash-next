import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Polyline, Marker } from 'react-leaflet';
import L from 'leaflet';
import { usePlaybackStore } from '@/app/playbackStore';
import { findNearestFrameIndex } from '@/lib/pidDecode';
import { ACCENT } from '@/lib/chartColors';
import type { TelemetryFrame } from '@/lib/types';

/**
 * Tile providers, best-first with graceful degradation. CARTO's hosted
 * basemaps are nice (raster styles; free with attribution, built on
 * OpenStreetMap data) but newer CARTO accounts/endpoints require an API key —
 * a hosted-key requirement this self-hosted app will never accept. So the
 * provider model carries a guaranteed fallback: standard OpenStreetMap raster
 * tiles, which need no key. Lifecycle: start on `carto`; if enough tiles fail
 * within a short window (see TILE_ERROR_THRESHOLD), flip to `osm` for the
 * component's lifetime. `{theme}` is replaced with the active theme for
 * themed providers only (light_all / dark_all).
 *
 * Exports (TILE_PROVIDERS, tileConfigFor, mapProviderAttribute, threshold
 * constants, recordTileError) are the pure provider model consumed by
 * mapView.test.ts — the component itself only wires them into Leaflet.
 */
export type TileProviderId = 'carto' | 'osm';
/** Theme resolved for a `{theme}`-placeholder URL ({theme}_all → light/dark). */
export type TileTheme = 'light' | 'dark';

export interface TileProvider {
  id: TileProviderId;
  /** Leaflet {s}/{z}/{x}/{y}/{r} + custom {theme} placeholders. */
  url: string;
  attribution: string;
  /** True when the URL carries a `{theme}` placeholder (dark_all/light_all). */
  themed: boolean;
}

export const TILE_PROVIDERS: readonly TileProvider[] = [
  {
    id: 'carto',
    url: 'https://{s}.basemaps.cartocdn.com/{theme}_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    themed: true,
  },
  {
    id: 'osm',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    themed: false,
  },
];

/** Resolve a provider's concrete URL + attribution for a theme. */
export function tileConfigFor(
  id: TileProviderId,
  theme: TileTheme,
): { url: string; attribution: string } {
  const p = TILE_PROVIDERS.find((p) => p.id === id) ?? TILE_PROVIDERS[0];
  return { url: p.url.replace('{theme}', theme), attribution: p.attribution };
}

/**
 * The `data-map-provider` value stamped on the component wrapper. Present
 * ONLY for `osm` so the dark-theme tile-pane invert filter in index.css is
 * scoped exclusively to the OSM fallback — the CARTO basemap has real dark
 * tiles and the attribute is absent, so the filter can never apply to it.
 */
export function mapProviderAttribute(
  id: TileProviderId,
): Exclude<TileProviderId, 'carto'> | undefined {
  return id === 'osm' ? 'osm' : undefined;
}

// ── Tile-error burst detection (pure, unit-testable) ─────────────────────
// A single tileerror is often transient (weak GPS-cam WiFi, one slow edge
// node). The provider only flips when ≥ THRESHOLD DISTINCT tiles fail inside
// WINDOW_MS of one another — repeated errors for the same tile count once.
// Distinctness is per-tile (url/coords key); the window is sliding and
// relative to the newest error.
export const TILE_ERROR_THRESHOLD = 3;
export const TILE_ERROR_WINDOW_MS = 10_000;

export interface TileErrorEntry {
  /** Distinct failing-tile key (tile src URL, or z/x/y coords fallback). */
  key: string;
  /** Epoch ms of the first (within-window) error for that key. */
  at: number;
}

/**
 * Fold one tileerror into the ledger. Returns the pruned/pushed ledger and
 * whether the burst threshold has been crossed. Pure — no Date.now() inside.
 */
export function recordTileError(
  ledger: readonly TileErrorEntry[],
  key: string,
  at: number,
): { ledger: TileErrorEntry[]; tripped: boolean } {
  const fresh = ledger.filter((e) => at - e.at <= TILE_ERROR_WINDOW_MS);
  if (fresh.some((e) => e.key === key)) {
    return { ledger: fresh, tripped: fresh.length >= TILE_ERROR_THRESHOLD };
  }
  const next = [...fresh, { key, at }];
  return { ledger: next, tripped: next.length >= TILE_ERROR_THRESHOLD };
}

/** Extract the distinct-tile key from a Leaflet `tileerror` event. */
function tileErrorKey(event: L.TileErrorEvent): string {
  const src = (event.tile as HTMLElement | undefined)?.getAttribute?.('src');
  if (src) return src;
  const c = event.coords;
  return c ? `#${c.z}/${c.x}/${c.y}` : '';
}

/**
 * Brand teardrop marker as a `divIcon` — replaces the stock Leaflet
 * `marker-icon.png` (which bundlers resolve to broken paths anyway and which
 * looked off against the accent palette). Accent fill, white hub, glow via
 * the `.torque-pin-icon` drop-shadow in index.css; the same class carries the
 * 140ms transform transition so playback scrubbing glides instead of
 * teleporting (the global reduced-motion guard neutralizes the transition).
 */
function buildPinIcon(): L.DivIcon {
  return L.divIcon({
    className: 'torque-pin-icon',
    html: `<svg width="26" height="34" viewBox="0 0 26 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13 1C6.4 1 1 6.3 1 12.9c0 8.6 9.5 16.5 11.3 20a.8.8 0 0 0 1.4 0C15.5 29.4 25 21.5 25 12.9 25 6.3 19.6 1 13 1Z" fill="${ACCENT}" stroke="rgb(4 33 31 / 0.5)" stroke-width="1"/><circle cx="13" cy="13" r="4.2" fill="#fff"/></svg>`,
    iconSize: [26, 34],
    iconAnchor: [13, 34],
  });
}

/**
 * Resolve the frame the marker should pin to when the map mounts with an
 * already-set playback cursor. The imperative subscription below only fires
 * on cursor CHANGES, so an entry position must be derived from the store's
 * CURRENT cursorTime explicitly. A null cursor (never scrubbed) yields null —
 * the map then keeps its default `position={center}` (= first frame).
 */
export function resolveFrameAtCursor(
  frames: TelemetryFrame[],
  cursorTime: number | null,
): TelemetryFrame | null {
  if (cursorTime == null || frames.length === 0) return null;
  // Precompute epoch-ms timestamps for the shared binary search.  The
  // nearest frame = frames[findNearestFrameIndex(timestamps, t)]; keep the
  // GPS-null policy: a chosen frame lacking lat/lon resolves to null.
  const timestamps = frames.map((f) => new Date(f.timestamp).getTime());
  const idx = findNearestFrameIndex(timestamps, cursorTime);
  const f = frames[idx];
  if (f == null || f.lat == null || f.lon == null) return null;
  return f;
}

interface Props {
  frames: TelemetryFrame[];
  /** Tailwind height classes for the MapContainer. */
  className?: string;
}

/**
 * GPS track replay. The <MapContainer> is mounted ONCE and must never be
 * re-rendered by cursor changes (doing so would destroy/recreate the Leaflet
 * map). Instead we subscribe to the playback store OUTSIDE React render and
 * imperatively call `marker.setLatLng(...)` on the nearest frame.
 */
export default function GpsTrackMap({ frames, className }: Props) {
  const markerRef = useRef<L.Marker | null>(null);
  const heightClass = className ?? 'h-64 md:h-[360px]';
  const pinIcon = useMemo(buildPinIcon, []);

  // ── Theme awareness for the basemap ────────────────────────────────
  // Cheap boolean read on mount + a class observer while mounted (the app
  // toggles `.dark` on <html> — see lib/theme.ts applyTheme). No chart lib
  // involvement, no setOption churn.
  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
      : false,
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(root.classList.contains('dark'));
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // ── Tile provider state (graceful degradation, component lifetime) ──
  // Starts on CARTO; a tileerror burst (≥ TILE_ERROR_THRESHOLD distinct
  // tiles inside TILE_ERROR_WINDOW_MS — see recordTileError) flips it to the
  // keyless standard-OSM provider for the rest of the component's life
  // (permanently — no recovery re-flip even if CARTO comes back). The error
  // ledger lives in a ref, so it also survives the keyed TileLayer remounts
  // a theme swap causes.
  // Plain state: the flip re-renders <TileLayer> under a new key (layer is
  // recreated, attribution control updates) — no map remount.
  const [providerId, setProviderId] = useState<TileProviderId>('carto');
  // Ledger + latch live in refs so the tileerror handler is a stable
  // callback (no listener churn on the layer) and reads never go stale.
  const tileFailuresRef = useRef<{ errors: TileErrorEntry[]; switched: boolean }>(
    { errors: [], switched: false },
  );

  const handleTileError = useCallback((event: L.TileErrorEvent) => {
    const bundle = tileFailuresRef.current;
    if (bundle.switched) return; // already on the fallback — map stays as is
    const key = tileErrorKey(event);
    if (!key) return;
    const { ledger, tripped } = recordTileError(bundle.errors, key, Date.now());
    tileFailuresRef.current = { errors: ledger, switched: tripped };
    if (tripped) setProviderId('osm');
  }, []);

  const positions = useMemo<[number, number][]>(
    () =>
      frames
        .filter((f) => f.lat != null && f.lon != null)
        .map((f) => [f.lat as number, f.lon as number]),
    [frames],
  );

  // Precompute epoch-ms timestamps once so cursor ticks binary-search without
  // re-parsing `new Date(...)` per comparison.
  const timestamps = useMemo<number[]>(
    () => frames.map((f) => new Date(f.timestamp).getTime()),
    [frames],
  );

  const theme: TileTheme = isDark ? 'dark' : 'light';
  const tileConfig = useMemo(
    () => tileConfigFor(providerId, theme),
    [providerId, theme],
  );
  const center: [number, number] = positions[0] ?? [0, 0];

  // Imperative subscription: move the marker whenever cursorTime changes.
  useEffect(() => {
    const unsubscribe = usePlaybackStore.subscribe((state) => {
      const t = state.cursorTime;
      if (t == null) return;
      const idx = findNearestFrameIndex(timestamps, t);
      const f = idx >= 0 ? frames[idx] : undefined;
      // GPS-null policy: if the chosen frame lacks lat/lon, don't move.
      if (!f || f.lat == null || f.lon == null || !markerRef.current) return;
      markerRef.current.setLatLng([f.lat as number, f.lon as number]);
    });

    // Synchronous first run: if a cursor is already set (e.g. the user
    // scrubbed in Dash mode before toggling to Map), pin the marker to the
    // matching frame immediately. Runs on every mount and frames change.
    const t0 = usePlaybackStore.getState().cursorTime;
    if (t0 != null) {
      const f0 = resolveFrameAtCursor(frames, t0);
      if (f0 && markerRef.current) {
        markerRef.current.setLatLng([f0.lat as number, f0.lon as number]);
      }
    }

    return unsubscribe;
  }, [frames, timestamps]);

  return (
    <div
      // Absent while CARTO serves; `'osm'` on the fallback. The dark-theme
      // tile-pane invert filter in index.css keys on this attribute.
      data-map-provider={mapProviderAttribute(providerId)}
      className={`w-full ${heightClass}`}
    >
      <MapContainer
        center={center}
        zoom={13}
        scrollWheelZoom
        className="h-full w-full"
      >
        <TileLayer
          // Key includes provider AND theme: a provider flip (or theme swap)
          // recreates the layer so the attribution control re-renders with
          // the active provider's notice.
          key={`${providerId}:${theme}`}
          url={tileConfig.url}
          attribution={tileConfig.attribution}
          eventHandlers={{ tileerror: handleTileError }}
        />
        <Polyline positions={positions} pathOptions={{ color: ACCENT, weight: 3 }} />
        {positions.length > 0 ? (
          <Marker ref={markerRef} position={center} icon={pinIcon} />
        ) : null}
      </MapContainer>
    </div>
  );
}
