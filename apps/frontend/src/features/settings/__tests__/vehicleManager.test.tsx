// @vitest-environment jsdom
/**
 * VehicleManager → session-cache invalidation (plan 035).
 *
 * VehicleController unassigns a deleted vehicle's sessions server-side, so
 * the frontend must also drop the `['sessions']` cache or the dashboard keeps
 * showing the deleted vehicle's name until a manual refetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import VehicleManager from '@/features/settings/VehicleManager';
import type { Vehicle } from '@/lib/types';

function shimHtmlDialogMethods() {
  const proto = window.HTMLDialogElement?.prototype as
    | (HTMLDialogElement & { showModal?: () => void; close?: () => void })
    | undefined;
  if (!proto) return;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal() {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function close() {
      this.removeAttribute('open');
    };
  }
}

shimHtmlDialogMethods();

const apiMocks = vi.hoisted(() => ({
  getVehicles: vi.fn(),
  createVehicle: vi.fn(),
  updateVehicle: vi.fn(),
  deleteVehicle: vi.fn(),
  setDefaultVehicle: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, ...apiMocks };
});

const VEHICLE: Vehicle = {
  id: 7,
  name: 'Civic',
  make: 'Honda',
  model: null,
  year: 2004,
  engineCc: 1600,
  isDefault: false,
  userId: 1,
};

describe('VehicleManager delete invalidation (jsdom)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getVehicles.mockResolvedValue([VEHICLE]);
    apiMocks.deleteVehicle.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invalidates the sessions cache after a vehicle is deleted', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    render(
      <QueryClientProvider client={client}>
        <VehicleManager />
      </QueryClientProvider>,
    );

    await screen.findByText('Civic');

    // Row Delete opens the confirm dialog; the dialog's own Delete confirms.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(apiMocks.deleteVehicle).toHaveBeenCalledWith(7));
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions'] }),
    );
  });
});
