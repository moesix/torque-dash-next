// @vitest-environment jsdom
/**
 * Plan 045 — SessionSummaryCard unit conversion:
 *  - US shows °F / mph
 *  - value, max AND label convert together (data-max proves the ring scale)
 *  - switching the preference re-renders in place (no stale memo / remount)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { TelemetryFrame, UserPreferences } from '@/lib/types';
import { usePlaybackStore } from '@/app/playbackStore';

const apiMocks = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, ...apiMocks };
});

import SessionSummaryCard from '@/components/charts/SessionSummaryCard';
import { UnitSystemProvider } from '@/app/unitSystem';

const BASE = new Date('2026-01-01T00:00:00.000Z').getTime();

const frames: TelemetryFrame[] = [
  {
    timestamp: new Date(BASE).toISOString(),
    lon: null,
    lat: null,
    values: { kc: 2000, k5: 90 },
    engineRpm: 2000,
    vehicleSpeed: 100,
  },
];

const prefs = (over: Partial<UserPreferences> = {}): UserPreferences => ({
  unitSystem: 'metric',
  serverDefault: 'metric',
  preference: null,
  ...over,
});

function renderCard(client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <UnitSystemProvider>
        <SessionSummaryCard frames={frames} maxRpm={8000} maxSpeed={240} maxCoolant={120} />
      </UnitSystemProvider>
    </QueryClientProvider> as ReactElement,
  );
}

function gauge(name: string): SVGSVGElement {
  return screen.getByRole('img', { name }) as unknown as SVGSVGElement;
}

describe('SessionSummaryCard units', () => {
  beforeEach(() => {
    apiMocks.getPreferences.mockReset();
    usePlaybackStore.setState({ cursorTime: BASE, isPlaying: false, speed: 1 });
  });

  it('renders metric exactly as before (km/h, °C, unconverted numbers)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMocks.getPreferences.mockResolvedValue(prefs());
    renderCard(client);

    const speed = await screen.findByRole('img', { name: 'Speed: 100 km/h' });
    expect(speed.getAttribute('data-max')).toBe('240');
    expect(speed.getAttribute('data-unit')).toBe('km/h');
    expect(screen.getByRole('img', { name: 'Coolant: 90°C' }).getAttribute('data-max')).toBe('120');
  });

  it('renders US: mph / °F and converts the gauge MAX too', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMocks.getPreferences.mockResolvedValue(prefs({ unitSystem: 'us', preference: 'us' }));
    renderCard(client);

    const speed = await screen.findByRole('img', { name: 'Speed: 62 mph' });
    expect(speed.getAttribute('data-max')).toBe('149'); // 240 km/h → 149 mph
    const coolant = screen.getByRole('img', { name: 'Coolant: 194°F' });
    expect(coolant.getAttribute('data-max')).toBe('248'); // 120 °C → 248 °F
    expect(screen.queryByRole('img', { name: /km\/h/ })).toBeNull();
    expect(screen.queryByRole('img', { name: /°C/ })).toBeNull();
  });

  it('switches units without remounting and re-renders the memoized series', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMocks.getPreferences.mockResolvedValue(prefs({ preference: 'metric' }));
    renderCard(client);

    expect(await screen.findByRole('img', { name: 'Speed: 100 km/h' })).toBeTruthy();

    act(() => {
      client.setQueryData(['preferences'], prefs({ unitSystem: 'us', preference: 'us' }));
    });

    expect(await screen.findByRole('img', { name: 'Speed: 62 mph' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Speed: 100 km/h' })).toBeNull();
  });
});
