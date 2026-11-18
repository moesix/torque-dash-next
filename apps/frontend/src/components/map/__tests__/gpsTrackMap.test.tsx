// @vitest-environment jsdom
/**
 * Rendering tests for GpsTrackMap's two new behaviours (plan 035):
 *
 *  - an empty / GPS-less frame list renders the explicit "No GPS data"
 *    placeholder and NO map at all (previously: an empty world map at 0,0);
 *  - a real track frames itself via `useMap().fitBounds(...)` — on the
 *    mounted Leaflet instance, so the map is never remounted (a remount would
 *    destroy the playback marker's imperative cursor subscription).
 *
 * The mapView.test.ts suite runs in the NODE environment and mocks the map
 * primitives to no-ops, so the mount assertions live here in a jsdom file.
 * react-leaflet is still mocked (jsdom has no layout engine for real tiles),
 * but the MapContainer stub renders the same `.leaflet-container` class the
 * real one does and exposes a scriptable `useMap` — which is exactly the
 * contract the component relies on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mapMock = vi.hoisted(() => ({
  current: { fitBounds: vi.fn(), setView: vi.fn() },
  mounts: 0,
}));

vi.mock('leaflet', () => ({
  default: {
    icon: () => ({}),
    divIcon: () => ({}),
    latLngBounds: (positions: unknown) => ({ positions }),
    Marker: { prototype: { options: {} } },
  },
}));

vi.mock('react-leaflet', async () => {
  const React = await import('react');
  const MapContainer = ({ children }: { children?: React.ReactNode }) => {
    React.useEffect(() => {
      mapMock.mounts += 1;
    }, []);
    return React.createElement(
      'div',
      { className: 'leaflet-container', 'data-testid': 'leaflet-map' },
      children,
    );
  };
  return {
    MapContainer,
    TileLayer: () => null,
    Polyline: () => null,
    Marker: () => null,
    useMap: () => mapMock.current,
  };
});

// The map reads tile settings through TanStack Query; the provider is
// irrelevant to these assertions, so stub the hook.
vi.mock('@/features/dashboard/hooks/useTileSettings', () => ({
  useTileSettings: () => ({ tileSettings: null, isTileSettingsLoading: false }),
}));

import GpsTrackMap from '@/components/map/GpsTrackMap';
import type { TelemetryFrame } from '@/lib/types';

function frame(
  timestamp: string,
  lat: number | null,
  lon: number | null,
): TelemetryFrame {
  return { timestamp, lat, lon, values: {}, engineRpm: null, vehicleSpeed: null };
}

describe('GpsTrackMap rendering (jsdom)', () => {
  beforeEach(() => {
    mapMock.current = { fitBounds: vi.fn(), setView: vi.fn() };
    mapMock.mounts = 0;
  });

  it('renders the no-GPS placeholder (and no map) for an empty frame list', () => {
    const { container } = render(<GpsTrackMap frames={[]} />);

    expect(screen.getByText('No GPS data in this session.')).toBeTruthy();
    expect(container.querySelector('.leaflet-container')).toBeNull();
    expect(screen.queryByTestId('leaflet-map')).toBeNull();
  });

  it('renders the no-GPS placeholder when every frame lacks coordinates', () => {
    const { container } = render(
      <GpsTrackMap
        frames={[
          frame('2026-01-01T00:00:00.000Z', null, null),
          frame('2026-01-01T00:00:10.000Z', null, null),
        ]}
      />,
    );

    expect(screen.getByText('No GPS data in this session.')).toBeTruthy();
    expect(container.querySelector('.leaflet-container')).toBeNull();
  });

  it('renders the map and fits the bounds to a multi-point track', () => {
    const { container } = render(
      <GpsTrackMap
        frames={[
          frame('2026-01-01T00:00:00.000Z', 45.0, 7.0),
          frame('2026-01-01T00:00:10.000Z', 45.2, 7.4),
        ]}
      />,
    );

    expect(container.querySelector('.leaflet-container')).not.toBeNull();
    const fitBounds = mapMock.current.fitBounds;
    expect(fitBounds).toHaveBeenCalledTimes(1);
    expect(fitBounds).toHaveBeenCalledWith(
      { positions: [[45.0, 7.0], [45.2, 7.4]] },
      { padding: [24, 24], maxZoom: 16 },
    );
    // A multi-point track must not also centre-step the map.
    expect(mapMock.current.setView).not.toHaveBeenCalled();
  });

  it('centres on a single-point track instead of fitting a degenerate bound', () => {
    render(
      <GpsTrackMap
        frames={[frame('2026-01-01T00:00:00.000Z', 45.0, 7.0)]}
      />,
    );

    expect(mapMock.current.setView).toHaveBeenCalledWith([45.0, 7.0], 15);
    expect(mapMock.current.fitBounds).not.toHaveBeenCalled();
  });

  it('re-fits on a new track without remounting the map', () => {
    const first = [
      frame('2026-01-01T00:00:00.000Z', 45.0, 7.0),
      frame('2026-01-01T00:00:10.000Z', 45.2, 7.4),
    ];
    const second = [
      frame('2026-01-01T01:00:00.000Z', 46.0, 8.0),
      frame('2026-01-01T01:00:10.000Z', 46.2, 8.4),
    ];

    const { rerender } = render(<GpsTrackMap frames={first} />);
    expect(mapMock.mounts).toBe(1);
    expect(mapMock.current.fitBounds).toHaveBeenCalledTimes(1);

    rerender(<GpsTrackMap frames={second} />);

    // Same MapContainer instance (count stayed 1) but the new track is framed.
    expect(mapMock.mounts).toBe(1);
    expect(mapMock.current.fitBounds).toHaveBeenCalledTimes(2);
    expect(mapMock.current.fitBounds).toHaveBeenLastCalledWith(
      { positions: [[46.0, 8.0], [46.2, 8.4]] },
      { padding: [24, 24], maxZoom: 16 },
    );
  });
});
