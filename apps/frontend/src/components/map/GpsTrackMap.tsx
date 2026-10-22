import { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, TileLayer, Polyline, Marker } from 'react-leaflet';
import L from 'leaflet';
import { usePlaybackStore } from '@/app/playbackStore';
import { findNearestFrameIndex } from '@/lib/pidDecode';
import { ACCENT } from '@/lib/chartColors';
import type { TelemetryFrame } from '@/lib/types';

/**
 * Theme-aware CARTO basemaps (raster styles; free with attribution, built on
 * OpenStreetMap data). light_all matches the light theme, dark_all the dark
 * one — the old OSM raster URL rendered identical colors in both themes.
 */
const TILE_URLS = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};

// Required attribution: CARTO plus upstream OpenStreetMap contributors.
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

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
    <MapContainer
      center={center}
      zoom={13}
      scrollWheelZoom
      className={`w-full ${heightClass}`}
    >
      <TileLayer
        url={isDark ? TILE_URLS.dark : TILE_URLS.light}
        attribution={TILE_ATTRIBUTION}
      />
      <Polyline positions={positions} pathOptions={{ color: ACCENT, weight: 3 }} />
      {positions.length > 0 ? (
        <Marker ref={markerRef} position={center} icon={pinIcon} />
      ) : null}
    </MapContainer>
  );
}
