import { useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, Polyline, Marker } from 'react-leaflet';
import L from 'leaflet';
import { usePlaybackStore } from '@/app/playbackStore';
import { findNearestFrameIndex } from '@/lib/pidDecode';
import type { TelemetryFrame } from '@/lib/types';

/**
 * Fix Leaflet's default marker icon path issue: with bundlers the icon image
 * URLs resolve to the wrong (non-existent) path, producing broken markers.
 * Pin them explicitly once at module load.
 */
const DefaultIcon = L.icon({
  iconRetinaUrl: '/marker-icon-2x.png',
  iconUrl: '/marker-icon.png',
  shadowUrl: '/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

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
      style={{ width: '100%' }}
      className={heightClass}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
      />
      <Polyline positions={positions} pathOptions={{ color: '#009999', weight: 3 }} />
      {positions.length > 0 ? (
        <Marker ref={markerRef} position={center} />
      ) : null}
    </MapContainer>
  );
}
