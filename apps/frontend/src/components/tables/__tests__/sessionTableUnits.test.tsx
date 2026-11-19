// @vitest-environment jsdom
/** Plan 045 — SessionTable's Max Speed cell follows the unit system. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { Session, UserPreferences } from '@/lib/types';

const apiMocks = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, ...apiMocks };
});

import SessionTable from '@/components/tables/SessionTable';
import { UnitSystemProvider } from '@/app/unitSystem';

const session: Session = {
  id: 's1',
  name: 'Trip',
  userId: 1,
  maxSpeed: 100,
  maxRpm: 2000,
  startDate: '2026-01-01T00:00:00.000Z',
  duration: '1h',
};

function renderTable(prefs: UserPreferences) {
  apiMocks.getPreferences.mockResolvedValue(prefs);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UnitSystemProvider>
        <MemoryRouter>
          <SessionTable sessions={[session]} />
        </MemoryRouter>
      </UnitSystemProvider>
    </QueryClientProvider> as ReactElement,
  );
}

describe('SessionTable units', () => {
  beforeEach(() => apiMocks.getPreferences.mockReset());

  it('metric shows km/h (unchanged)', async () => {
    renderTable({ unitSystem: 'metric', serverDefault: 'metric', preference: null });
    expect(await screen.findByText('100 km/h')).toBeTruthy();
  });

  it('US shows mph', async () => {
    renderTable({ unitSystem: 'us', serverDefault: 'metric', preference: 'us' });
    expect(await screen.findByText('62 mph')).toBeTruthy();
    expect(screen.queryByText('100 km/h')).toBeNull();
  });

  it('UK shows mph', async () => {
    renderTable({ unitSystem: 'uk', serverDefault: 'metric', preference: 'uk' });
    expect(await screen.findByText('62 mph')).toBeTruthy();
  });
});
