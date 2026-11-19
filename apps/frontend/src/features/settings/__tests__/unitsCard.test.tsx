// @vitest-environment jsdom
/**
 * Plan 045 — UnitsCard: four choices (inherit + three systems), optimistic
 * save, rollback on error, and a live preview that follows the formatter.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { UserPreferences } from '@/lib/types';

const apiMocks = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, ...apiMocks };
});

import UnitsCard from '@/features/settings/UnitsCard';
import { UnitSystemProvider } from '@/app/unitSystem';

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UnitSystemProvider>
        <UnitsCard />
      </UnitSystemProvider>
    </QueryClientProvider> as ReactElement,
  );
}

const prefs = (over: Partial<UserPreferences> = {}): UserPreferences => ({
  unitSystem: 'metric',
  serverDefault: 'metric',
  preference: null,
  ...over,
});

describe('UnitsCard', () => {
  beforeEach(() => {
    apiMocks.getPreferences.mockReset();
    apiMocks.updatePreferences.mockReset();
  });

  it('labels the inherit option with the server default', async () => {
    apiMocks.getPreferences.mockResolvedValue(prefs({ serverDefault: 'us', unitSystem: 'us' }));
    renderCard();
    expect(await screen.findByLabelText('Server default (US customary)')).toBeTruthy();
  });

  it('shows a metric preview by default', async () => {
    apiMocks.getPreferences.mockResolvedValue(prefs());
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId('units-preview').textContent).toContain('100 km/h · 90 °C · 240 kPa → 100 km/h'),
    );
  });

  it('saves US customary and updates the preview to °F/psi', async () => {
    apiMocks.getPreferences.mockResolvedValue(prefs());
    apiMocks.updatePreferences.mockResolvedValue(
      prefs({ unitSystem: 'us', preference: 'us' }),
    );
    const user = userEvent.setup();
    renderCard();
    await screen.findByLabelText(/US customary/);

    await user.click(screen.getByLabelText(/US customary/));

    expect(apiMocks.updatePreferences).toHaveBeenCalledWith('us');
    await waitFor(() =>
      expect(screen.getByTestId('units-preview').textContent).toBe(
        '100 km/h · 90 °C · 240 kPa → 62 mph · 194 °F · 35 psi',
      ),
    );
    expect(screen.getByText('Saved.')).toBeTruthy();
  });

  it('sends null when the inherit option is chosen', async () => {
    apiMocks.getPreferences.mockResolvedValue(
      prefs({ unitSystem: 'us', serverDefault: 'us', preference: 'us' }),
    );
    apiMocks.updatePreferences.mockResolvedValue(
      prefs({ unitSystem: 'us', serverDefault: 'us', preference: null }),
    );
    const user = userEvent.setup();
    renderCard();
    await user.click(await screen.findByLabelText('Server default (US customary)'));
    expect(apiMocks.updatePreferences).toHaveBeenCalledWith(null);
  });

  it('rolls the selection back and shows an error when the save fails', async () => {
    apiMocks.getPreferences.mockResolvedValue(prefs({ preference: 'metric' }));
    apiMocks.updatePreferences.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderCard();
    const metric = await screen.findByLabelText(/^Metric/);
    await waitFor(() => expect((metric as HTMLInputElement).checked).toBe(true));

    await user.click(screen.getByLabelText(/US customary/));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    await waitFor(() => expect((metric as HTMLInputElement).checked).toBe(true));
  });
});
