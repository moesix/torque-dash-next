// @vitest-environment jsdom
/**
 * Behavior tests for the fleet overview page (Plan 021).
 *
 * Contract under test:
 * - One row per vehicle, including zero-session vehicles (count 0, maxima "—").
 * - Clicking a row routes to the session browser with `?vehicleId=<id>`.
 * - Maxima render through the unit system: US preference shows mph, metric
 *   shows km/h (never a bare hard-coded km/h label).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import FleetOverview from '../FleetOverview';
import { UnitSystemProvider } from '@/app/unitSystem';
import { getFleetOverview, getPreferences } from '@/lib/api';
import type { FleetRow, UnitSystem, UserPreferences } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  getFleetOverview: vi.fn(),
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));

const getFleetOverviewMock = vi.mocked(getFleetOverview);
const getPreferencesMock = vi.mocked(getPreferences);

const ROWS: FleetRow[] = [
  {
    vehicleId: 7,
    name: 'Beta',
    make: 'Honda',
    model: 'Civic',
    engineCc: 1600,
    sessionCount: 12,
    lastActivityAt: '2026-11-18T09:30:00.000Z',
    maxRpm: 6800,
    maxSpeed: 142,
  },
  {
    vehicleId: 8,
    name: 'Alpha',
    make: null,
    model: null,
    engineCc: null,
    sessionCount: 0,
    lastActivityAt: null,
    maxRpm: null,
    maxSpeed: null,
  },
  {
    vehicleId: null,
    name: 'Unassigned',
    make: null,
    model: null,
    engineCc: null,
    sessionCount: 2,
    lastActivityAt: '2026-11-17T08:00:00.000Z',
    maxRpm: 3000,
    maxSpeed: 60,
  },
];

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderFleet({ withUnits = false, system = 'metric' as UnitSystem } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const prefs: UserPreferences = {
    unitSystem: system,
    serverDefault: 'metric',
    preference: system === 'metric' ? null : system,
  };
  getPreferencesMock.mockResolvedValue(prefs);

  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/fleet']}>
        <Routes>
          <Route path="/fleet" element={<FleetOverview />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  return render(
    withUnits ? (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/fleet']}>
          <UnitSystemProvider>
            <Routes>
              <Route path="/fleet" element={<FleetOverview />} />
              <Route path="*" element={<LocationProbe />} />
            </Routes>
          </UnitSystemProvider>
        </MemoryRouter>
      </QueryClientProvider>
    ) : tree,
  );
}

describe('FleetOverview (jsdom)', () => {
  beforeEach(() => {
    getFleetOverviewMock.mockReset();
    getPreferencesMock.mockReset();
    getFleetOverviewMock.mockResolvedValue(ROWS);
  });

  it('renders a row per vehicle, including a zero-session vehicle', async () => {
    renderFleet();

    const beta = await screen.findByRole('button', { name: 'Vehicle: Beta' });
    expect(beta.textContent).toContain('Honda Civic');
    expect(beta.textContent).toContain('12');
    expect(beta.textContent).toContain('6,800');
    expect(beta.textContent).toContain('142 km/h');

    const alpha = screen.getByRole('button', { name: 'Vehicle: Alpha' });
    // Zero-session vehicle is present: count 0 and dashes for the maxima.
    expect(alpha.textContent).toContain('0');
    expect(alpha.textContent).toContain('—');

    const unassigned = screen.getByRole('button', { name: 'Vehicle: Unassigned' });
    expect(unassigned.textContent).toContain('2');

    expect(getFleetOverviewMock).toHaveBeenCalledWith(90);
  });

  it('navigates with ?vehicleId=<id> when a row is clicked', async () => {
    renderFleet();

    fireEvent.click(await screen.findByRole('button', { name: 'Vehicle: Beta' }));

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/?vehicleId=7');
    });
  });

  it('sends the Unassigned row to the unfiltered session list', async () => {
    renderFleet();

    fireEvent.click(await screen.findByRole('button', { name: 'Vehicle: Unassigned' }));

    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/');
    });
  });

  it('renders speed in mph under the US unit preference', async () => {
    renderFleet({ withUnits: true, system: 'us' });

    const beta = await screen.findByRole('button', { name: 'Vehicle: Beta' });
    await waitFor(() => expect(beta.textContent).toContain('88 mph'));
    // The metric label must not leak through under a US preference.
    expect(beta.textContent).not.toMatch(/km\/h/);
  });
});
