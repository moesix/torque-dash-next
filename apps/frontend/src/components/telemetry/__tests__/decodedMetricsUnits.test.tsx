// @vitest-environment jsdom
/** Plan 045 — DecodedMetricsTable converts the numeric columns and labels. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { SeriesSource, UserPreferences } from '@/lib/types';
import type { SeriesStats } from '@/lib/pidDecode';

const apiMocks = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, ...apiMocks };
});

import DecodedMetricsTable from '@/components/telemetry/DecodedMetricsTable';
import { UnitSystemProvider } from '@/app/unitSystem';

const sources: SeriesSource[] = [
  { pid: 'vehicleSpeed', full: 'Vehicle Speed', short: 'Speed', unit: 'km/h', source: 'column', field: 'vehicleSpeed' },
  { pid: 'k5', full: 'Engine Coolant Temperature', short: 'Coolant', unit: '°C', source: 'pid' },
  { pid: 'kc', full: 'Engine RPM', short: 'Revs', unit: 'rpm', source: 'pid' },
];

const stat = (min: number, max: number, avg: number, last: number): SeriesStats => ({
  min, max, avg, last, count: 3,
});

const stats = new Map<string, SeriesStats | null>([
  ['vehicleSpeed', stat(0, 100, 50, 100)],
  ['k5', stat(80, 90, 85, 90)],
  ['kc', stat(800, 2000, 1400, 2000)],
]);

const usPrefs: UserPreferences = {
  unitSystem: 'us',
  serverDefault: 'metric',
  preference: 'us',
};

function renderTable(prefs: UserPreferences) {
  apiMocks.getPreferences.mockResolvedValue(prefs);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UnitSystemProvider>
        <DecodedMetricsTable sources={sources} stats={stats} />
      </UnitSystemProvider>
    </QueryClientProvider> as ReactElement,
  );
}

function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name);
  return cell.closest('tr') as HTMLElement;
}

describe('DecodedMetricsTable units', () => {
  beforeEach(() => apiMocks.getPreferences.mockReset());

  it('metric keeps today’s labels and numbers', async () => {
    renderTable({ unitSystem: 'metric', serverDefault: 'metric', preference: null });
    await screen.findByText('Speed');
    expect(within(rowFor('Speed')).getByText('km/h')).toBeTruthy();
    expect(within(rowFor('Speed')).getAllByText('100').length).toBeGreaterThan(0);
    expect(within(rowFor('Revs')).getByText('rpm')).toBeTruthy();
  });

  it('US converts values and unit labels', async () => {
    renderTable(usPrefs);
    await screen.findByText('mph');
    expect(within(rowFor('Speed')).getByText('mph')).toBeTruthy();
    expect(within(rowFor('Speed')).getAllByText('62.1').length).toBeGreaterThan(0);
    expect(within(rowFor('Coolant')).getByText('°F')).toBeTruthy();
    expect(within(rowFor('Coolant')).getAllByText('194').length).toBeGreaterThan(0);
    // Non-convertible units keep their label and values.
    expect(within(rowFor('Revs')).getByText('rpm')).toBeTruthy();
    expect(within(rowFor('Revs')).getAllByText('2,000').length).toBeGreaterThan(0);
  });
});
