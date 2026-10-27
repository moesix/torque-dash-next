// @vitest-environment jsdom
/**
 * Behavior tests for the sessions browser's "Load More" pagination.
 *
 * Contract under test:
 * - Pages ACCUMULATE: each Load More click appends a page to the table
 *   instead of replacing the rows already on screen.
 * - The button label reports the number of loaded rows against the server's
 *   total, and disappears once everything is loaded.
 * - Changing the vehicle filter starts a fresh query key at offset 0 and
 *   shows only that vehicle's sessions (no rows from the previous filter).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import SessionBrowser from '../SessionBrowser';
import { getSessions, getVehicles } from '@/lib/api';
import type { Session, Vehicle } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  getSessions: vi.fn(),
  getVehicles: vi.fn(),
  renameSession: vi.fn(),
}));

const getSessionsMock = vi.mocked(getSessions);
const getVehiclesMock = vi.mocked(getVehicles);

function makeSession(id: string, name: string): Session {
  return { id, name, userId: 1 };
}

function makeVehicle(id: number, name: string): Vehicle {
  return {
    id,
    name,
    make: null,
    model: null,
    year: null,
    engineCc: null,
    isDefault: false,
    userId: 1,
  };
}

const PAGE_0 = [makeSession('a1', 'Alpha 1'), makeSession('a2', 'Alpha 2'), makeSession('a3', 'Alpha 3')];
const PAGE_1 = [makeSession('b1', 'Bravo 1'), makeSession('b2', 'Bravo 2'), makeSession('b3', 'Bravo 3')];
const PAGE_2 = [makeSession('c1', 'Charlie 1'), makeSession('c2', 'Charlie 2'), makeSession('c3', 'Charlie 3')];
const ALL_SESSIONS = [...PAGE_0, ...PAGE_1, ...PAGE_2];
// The mock serves 3 rows per page so accumulation is observable without
// rendering 50-row fixtures. getNextPageParam passes the number of loaded
// rows as the next offset, so the slices line up with PAGE_0/1/2.
const MOCK_PAGE_SIZE = 3;
const CAR_PAGE_0 = [makeSession('v1', 'Car one'), makeSession('v2', 'Car two')];

function renderBrowser() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SessionBrowser />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function rowNames(): string[] {
  return screen
    .queryAllByRole('button', { name: /^Session: / })
    .map((el) => el.getAttribute('aria-label')?.replace('Session: ', '') ?? '');
}

describe('SessionBrowser pagination (jsdom)', () => {
  beforeEach(() => {
    getSessionsMock.mockReset();
    getVehiclesMock.mockReset();
    getVehiclesMock.mockResolvedValue([]);

    // Nine sessions across three pages of three, mirroring the server's
    // { sessions, total } shape for every offset.
    getSessionsMock.mockImplementation(async (_limit, offset = 0, vehicleId) => {
      if (vehicleId === 1) {
        return { sessions: CAR_PAGE_0, total: CAR_PAGE_0.length, limit: 50, offset };
      }
      const sessions = ALL_SESSIONS.slice(offset, offset + MOCK_PAGE_SIZE);
      return { sessions, total: ALL_SESSIONS.length, limit: 50, offset };
    });
  });

  it('appends pages instead of replacing rows and updates the total label', async () => {
    renderBrowser();

    await waitFor(() => expect(rowNames()).toHaveLength(3));
    expect(rowNames()).toEqual(['Alpha 1', 'Alpha 2', 'Alpha 3']);
    expect(screen.getByRole('button', { name: 'Load More (3 of 9)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load More (3 of 9)' }));

    await waitFor(() => expect(rowNames()).toHaveLength(6));
    expect(rowNames()).toEqual([
      'Alpha 1', 'Alpha 2', 'Alpha 3',
      'Bravo 1', 'Bravo 2', 'Bravo 3',
    ]);
    expect(screen.getByRole('button', { name: 'Load More (6 of 9)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load More (6 of 9)' }));

    await waitFor(() => expect(rowNames()).toHaveLength(9));
    expect(rowNames()).toContain('Charlie 3');
    expect(screen.queryByRole('button', { name: /^Load More/ })).toBeNull();

    expect(getSessionsMock.mock.calls.map(([, offset]) => offset)).toEqual([0, 3, 6]);
  });

  it('starts a fresh page-0 query when the vehicle filter changes', async () => {
    getVehiclesMock.mockResolvedValue([makeVehicle(1, 'Car A')]);
    renderBrowser();

    await waitFor(() => expect(rowNames()).toHaveLength(3));

    fireEvent.change(await screen.findByLabelText('Filter by vehicle:'), {
      target: { value: '1' },
    });

    await waitFor(() => expect(rowNames()).toEqual(['Car one', 'Car two']));
    expect(rowNames()).not.toContain('Alpha 1');

    const lastCall = getSessionsMock.mock.calls[getSessionsMock.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe(50);
    expect(lastCall?.[1]).toBe(0);
    expect(lastCall?.[2]).toBe(1);
  });
});
