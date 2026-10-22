import { useQuery } from '@tanstack/react-query';
import { getFullSettings } from '@/lib/api';

/**
 * Map-relevant tile settings (Settings slice) for the GPS replay map,
 * fetched from authenticated GET /api/settings/full via lib/api.
 *
 * Follows the useSessionTelemetry TanStack pattern. Failure semantics are
 * deliberate and consumed by GpsTrackMap.resolveTileTargets:
 *
 * - `tileProvider` is ALWAYS present ('osm' default); `cartoApiKey` is
 *   surfaced by the backend ONLY while 'carto' is active — the browser
 *   embeds it in tile URLs, so it must never be logged or consoled here.
 * - On fetch failure (network rot, expired session after the api-layer
 *   redirect, endpoint error) `tileSettings` degrades to null — the map
 *   resolves OSM and the dashboard's sessions list never breaks because of
 *   settings.
 *
 * retry: false keeps a broken settings endpoint from retry-storming in the
 * background of an already-heavy replay dashboard; staleTime keeps the map
 * from recomputing keyed tile URLs (which remounts the TileLayer) on
 * unrelated query-cache events.
 */
export function useTileSettings() {
  const query = useQuery({
    queryKey: ['settings', 'tile'],
    queryFn: getFullSettings,
    retry: false,
    staleTime: 5 * 60_000,
  });

  return {
    tileSettings: query.data ?? null,
    isTileSettingsLoading: query.isLoading,
  };
}
