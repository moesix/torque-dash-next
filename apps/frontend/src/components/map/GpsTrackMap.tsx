import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Polyline, Marker } from 'react-leaflet';
import L from 'leaflet';
import { usePlaybackStore } from '@/app/playbackStore';
import { findNearestFrameIndex } from '@/lib/pidDecode';
import { ACCENT } from '@/lib/chartColors';
import type { TelemetryFrame } from '@/lib/types';
import { useTileSettings } from '@/features/dashboard/hooks/useTileSettings';

/**
 * Tile providers, settings-driven with a keyless guaranteed base. Standard
 * OpenStreetMap raster tiles need no key and are the DEFAULT provider.
 * CARTO's hosted basemaps are the opt-in admin upgrade: they only activate
 * when GET /api/settings/full returns tileProvider === 'carto' AND a
 * non-empty cartoApiKey (the admin's key, surfaced by the backend only while
 * carto is active). Blank keys, missing fields, and fetch failure all
 * resolve to OSM — a wrong key is the one case we cannot detect (see
 * resolveTileTargets below).
 *
 * Lifecycle: the effective provider comes from resolveTileTargets(settings,
 * theme); while CARTO is effectively active, a tileerror burst (see
 * TILE_ERROR_THRESHOLD) latches a degrade to keyless OSM for the session —
 * that latch never does anything while OSM is already the provider.
 * `{theme}` is replaced with the active theme for themed providers only
 * (light_all / dark_all).
 *
 * Exports (TILE_PROVIDERS, tileConfigFor, resolveTileTargets,
 * mapProviderAttribute, threshold constants, recordTileError) are the pure
 * provider model consumed by mapView.test.ts — the component itself only
 * wires them into Leaflet.
 */
export type TileProviderId = 'carto' | 'osm';
/** Theme resolved for a `{theme}`-placeholder URL ({theme}_all → light/dark). */
export type TileTheme = 'light' | 'dark';

/**
 * The map-relevant slice of the authenticated GET /api/settings/full shape
 * (lib/types.ts Settings). Structural on purpose: the backend omits
 * cartoApiKey whenever OSM is the configured provider, so every field is
 * optional; `undefined`/`null` settings (fetch failure) also route here and
 * must resolve to OSM.
 */
export interface AppTileSettings {
  tileProvider?: 'osm' | 'carto';
  /** Admin's CARTO API key. Browser credential — the map embeds it in tile
   *  URLs; never log it, never console it. */
  cartoApiKey?: string;
}

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
    id: 'osm',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    themed: false,
  },
  {
    id: 'carto',
    url: 'https://{s}.basemaps.cartocdn.com/{theme}_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    themed: true,
  },
];

/**
 * Resolve a provider's concrete URL + attribution for a theme. Pure and
 * key-blind: this is the BASE template only — the keyed CARTO URL is built
 * by resolveTileTargets (below) so no API key ever lives inside
 * TILE_PROVIDERS or leaks through this path.
 */
export function tileConfigFor(
  id: TileProviderId,
  theme: TileTheme,
): { url: string; attribution: string } {
  const p = TILE_PROVIDERS.find((p) => p.id === id) ?? TILE_PROVIDERS[0];
  return { url: p.url.replace('{theme}', theme), attribution: p.attribution };
}

export interface TileTarget {
  /** Effectively-served provider. */
  providerId: TileProviderId;
  /** Concrete Leaflet URL ({theme} already resolved, key already appended). */
  url: string;
  attribution: string;
  /** True only when the resolved URL embeds the admin's CARTO key —
   *  i.e. the vendor sees a keyed (billable/attributed) request. */
  keyedStamp: boolean;
}

/**
 * THE provider-resolution rule (settings-driven, OSM-default):
 *
 *   settings.tileProvider === 'carto' AND non-empty cartoApiKey
 *     → CARTO, with the key appended per CARTO's documented convention for
 *       the hosted raster basemap endpoint: a `key` query parameter on the
 *       tile URL (carto.com/basemaps/docs — Leaflet raster example).
 *   anything else → OSM.
 *
 * `anything else` covers: OSM configured, CARTO configured with a blank key
 * (the backend permits '', a deliberate mid-state — tiles degrade to OSM
 * until a key is saved, which the Settings card copy explains),
 * missing/optional fields, and settings === undefined (settings fetch
 * failed — the replay dashboard's sessions list must never break, so the
 * map degrades to the keyless base).
 *
 * KNOWN LIMITATION, by design: a WRONG key still resolves HTTP-200 vendor
 * error-card tiles (CARTO serves 200 images displaying the key message, so
 * the tileerror burst cannot catch it). That's the admin's configured
 * choice — the Settings card copy tells the admin to verify the key and
 * domain-allowlist it. We deliberately do NOT attempt to detect card tiles.
 *
 * Pure: no I/O, no Date.now(). The key is embedded in the returned URL only
 * (encodeURIComponent keeps reserved characters out of the query) — never
 * logged, never consoled by any consumer of this module.
 */
export function resolveTileTargets(
  settings: AppTileSettings | null | undefined,
  theme: TileTheme,
): TileTarget {
  const key =
    typeof settings?.cartoApiKey === 'string' ? settings.cartoApiKey.trim() : '';
  if (settings?.tileProvider === 'carto' && key !== '') {
    const base = tileConfigFor('carto', theme);
    return {
      providerId: 'carto',
      url: `${base.url}?key=${encodeURIComponent(key)}`,
      attribution: base.attribution,
      keyedStamp: true,
    };
  }
  return {
    providerId: 'osm',
    ...tileConfigFor('osm', theme),
    keyedStamp: false,
  };
}

/**
 * The `data-map-provider` value stamped on the component wrapper. Present
 * ONLY while `osm` is effectively serving — the keyless DEFAULT, or the
 * burst/degrade fallback while settings say carto — so the dark-theme
 * tile-pane invert filter in index.css never applies to a CARTO basemap,
 * which has real dark tiles.
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

/**
 * Evenly decimate a position list for static rendering: keeps at most `max`
 * vertices, ALWAYS including the first and last, so the drawn track starts and
 * ends exactly where the recording did. Returns the input untouched when it is
 * already within budget. Pure — the played-back marker keeps using the full
 * frames array.
 */
export function decimatePositions(
  positions: [number, number][],
  max = 4000,
): [number, number][] {
  const n = positions.length;
  if (n <= max || max < 2) return positions;
  const step = (n - 1) / (max - 1);
  const out: [number, number][] = new Array(max);
  for (let i = 0; i < max; i++) {
    out[i] = positions[Math.round(i * step)];
  }
  out[max - 1] = positions[n - 1];
  return out;
}

/**
 * Split a position list wherever consecutive longitudes jump across the
 * antimeridian (|Δlon| > 180°): Leaflet would otherwise join the two points
 * with a full-width streak. Longitudes are left unnormalized — the map
 * renders the original coordinates, just as separate polylines.
 */
export function splitAntimeridian(
  positions: [number, number][],
): [number, number][][] {
  if (positions.length === 0) return [];
  const segments: [number, number][][] = [];
  let current: [number, number][] = [positions[0]];
  for (let i = 1; i < positions.length; i++) {
    const prev = positions[i - 1];
    const next = positions[i];
    if (Math.abs(next[1] - prev[1]) > 180) {
      segments.push(current);
      current = [next];
    } else {
      current.push(next);
    }
  }
  segments.push(current);
  return segments;
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

  // ── Tile provider state (settings-driven + graceful degradation) ────
  // The base resolution is settings-driven (resolveTileTargets): settings
  // undefined (query still loading, or the /api/settings/full call failed)
  // resolves to OSM, so the map always renders with the keyless base and
  // never breaks the sessions view. When CARTO+key resolves, a tileerror
  // burst (≥ TILE_ERROR_THRESHOLD distinct tiles inside
  // TILE_ERROR_WINDOW_MS — see recordTileError) latches a degrade to
  // keyless OSM for the rest of the component's life (mid-session key
  // revocation / net rot). The latch NEVER flips when OSM is already
  // effectively active — the handler is only attached while the resolved
  // provider is carto. The error ledger lives in a ref, so it survives the
  // keyed TileLayer remounts a theme swap causes.
  //
  // A settings CHANGE under the same component instance (admin edits the
  // provider/key) re-arms the safety net: the latch and ledger reset. The
  // key value is referenced ONLY as a dependency-array identity — it is
  // never logged, never consoled.
  //
  // Plain state: a flip re-renders <TileLayer> under a new key (layer is
  // recreated, attribution control updates) — no map remount.
  const { tileSettings } = useTileSettings();

  const [sessionFallbackOsm, setSessionFallbackOsm] = useState(false);

  // Ledger + latch live in refs so the tileerror handler is a stable
  // callback (no listener churn on the layer) and reads never go stale.
  const tileFailuresRef = useRef<{ errors: TileErrorEntry[]; switched: boolean }>(
    { errors: [], switched: false },
  );

  // Settings epoch reset: whenever the ADMIN-CONFIGURED tile input changes
  // (provider flipped, key set/cleared/rotated), re-arm the burst safety net
  // so the new configuration gets its own failure window. Theme is NOT part
  // of this identity — a light/dark flip must not un-latch mid-session.
  const settingsKey = tileSettings?.tileProvider;
  const settingsKeyValue = tileSettings?.cartoApiKey;
  useEffect(() => {
    tileFailuresRef.current = { errors: [], switched: false };
    setSessionFallbackOsm(false);
  }, [settingsKey, settingsKeyValue]);

  const handleTileError = useCallback((event: L.TileErrorEvent) => {
    const bundle = tileFailuresRef.current;
    if (bundle.switched) return; // already on the fallback — map stays as is
    const key = tileErrorKey(event);
    if (!key) return;
    const { ledger, tripped } = recordTileError(bundle.errors, key, Date.now());
    tileFailuresRef.current = { errors: ledger, switched: tripped };
    if (tripped) setSessionFallbackOsm(true);
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

  // Static route rendering: one leaflet polyline per antimeridian-safe
  // segment, decimated to a bounded vertex count. Marker playback below stays
  // bound to the full `frames` (exact positions on every cursor tick).
  const routeSegments = useMemo<[number, number][][]>(
    () => splitAntimeridian(decimatePositions(positions)),
    [positions],
  );

  const theme: TileTheme = isDark ? 'dark' : 'light';
  // Settings-driven effective target ({theme} resolved, key appended).
  // OSM while settings are absent (loading/failed) — the map never blocks on
  // the settings call.
  const resolved = useMemo<TileTarget>(
    () => resolveTileTargets(tileSettings, theme),
    [tileSettings, theme],
  );
  // The EFFECTIVE provider: settings resolution unless the session-wide
  // burst latch has degraded it to keyless OSM.
  const providerId: TileProviderId = sessionFallbackOsm ? 'osm' : resolved.providerId;
  const tileConfig = useMemo<TileTarget>(
    // Session-fallback latch: degrade to the keyless OSM template even while
    // the settings still say carto.
    () => (sessionFallbackOsm ? { ...tileConfigFor('osm', theme), providerId: 'osm', keyedStamp: false } : resolved),
    [sessionFallbackOsm, resolved, theme],
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
      // `'osm'` only while the keyless OpenStreetMap provider is effectively
      // serving — the default base, OR the burst-fallback degrade while the
      // settings say carto. Absent while keyed CARTO serves (its dark tiles
      // are real, so the `.dark` invert filter in index.css must not touch
      // it — the filter scopes on this attribute).
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
          // the active provider's notice. The URL may embed the admin's
          // CARTO key — never printed, never logged anywhere.
          key={`${providerId}:${theme}`}
          url={tileConfig.url}
          attribution={tileConfig.attribution}
          // The tileerror burst safety net is wired ONLY while keyed CARTO
          // is effectively active: a degrade latch to keyless OSM is
          // meaningful exactly then. While OSM serves (default or fallback)
          // no handler is attached, so the latch can never fire.
          eventHandlers={
            providerId === 'carto' ? { tileerror: handleTileError } : {}
          }
        />
        {routeSegments.map((segment, i) => (
          <Polyline
            key={i}
            positions={segment}
            pathOptions={{ color: ACCENT, weight: 3 }}
          />
        ))}
        {positions.length > 0 ? (
          <Marker ref={markerRef} position={center} icon={pinIcon} />
        ) : null}
      </MapContainer>
    </div>
  );
}
