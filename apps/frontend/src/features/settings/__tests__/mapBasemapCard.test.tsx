// @vitest-environment jsdom
/**
 * Behavior tests for the "Map basemaps" admin card (MapBasemapCard.tsx),
 * mirroring the structure of the component suite at
 * src/components/charts/__tests__/sessionSummaryCard.test.tsx: real
 * component mount in jsdom, data/IO layer mocked, assertions on visible UI.
 *
 * Contract under test:
 * - The card shows the CURRENTLY STORED provider (from the loaded
 *   /api/settings/full data passed by SettingsPage) in the status Badge —
 *   not the unsaved draft.
 * - Provider select toggles the (hidden-when-OSM) masked CARTO key input.
 * - Saving under CARTO PUTs tileProvider 'carto' + the entered key verbatim
 *   (trims/normalizing is the backend's job); a blank key is allowed to
 *   save but shows the fall-back-to-OSM hint (resolveTileTargets degrades
 *   blank-key carto to OSM).
 * - Saving under OSM PUTs only tileProvider 'osm' (never touches the stored
 *   key) and hides the key input.
 * - The card is key-hygienic: an entered key is never rendered as text
 *   (password input) — only its presence is visible.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MapBasemapCard from '../MapBasemapCard';
import { updateSettings } from '@/lib/api';
import type { Settings } from '@/lib/types';

// The card reads the tile-settings query cache after a save (invalidateQueries);
// mount through the same provider the app uses so that path has a client.
function renderCard(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

vi.mock('@/lib/api', () => ({
  updateSettings: vi.fn(),
}));

const updateMock = vi.mocked(updateSettings);

function settingsFixture(overrides: Partial<Settings> = {}): Settings {
  return {
    disableRegistration: false,
    hasUploadApiToken: false,
    tokenFromEnv: false,
    hasLlmProvider: false,
    llmProvider: null,
    llmModel: null,
    llmEndpoint: null,
    hasLlmApiKey: false,
    vehicleMake: null,
    vehicleModel: null,
    vehicleYear: null,
    engineCc: null,
    llmThinkingMode: true,
    llmReasoningEffort: 'high',
    timezoneOffset: 0,
    retentionEnabled: false,
    retentionDays: 365,
    analysisRetentionDays: null,
    tileProvider: 'osm',
    ...overrides,
  };
}

async function selectProvider(value: string) {
  fireEvent.change(screen.getByLabelText('Provider'), {
    target: { value },
  });
}

describe('MapBasemapCard (jsdom)', () => {
  beforeEach(() => {
    updateMock.mockReset();
  });

  it('shows the stored provider in the status badge (OSM default)', () => {
    renderCard(<MapBasemapCard settings={settingsFixture()} onUpdate={vi.fn()} />);
    expect(screen.getByText('Standard OSM (default)')).toBeTruthy();
    // The key input is hidden entirely while OSM is the draft provider.
    expect(screen.queryByLabelText('CARTO API key')).toBeNull();
  });

  it('badge distinguishes keyed CARTO from blank-key CARTO (which falls back)', () => {
    const { rerender, unmount } = renderCard(
      <MapBasemapCard
        // carto configured with a non-empty stored key (backend only
        // returns the key while carto is active).
        settings={settingsFixture({ tileProvider: 'carto', cartoApiKey: 'k' })}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByText('CARTO basemap')).toBeTruthy();
    unmount();

    renderCard(
      <MapBasemapCard
        // Key cleared/absent while carto is still saved — the badge warns
        // about the OSM degrade rather than claiming CARTO is live.
        settings={settingsFixture({ tileProvider: 'carto', cartoApiKey: undefined })}
        onUpdate={vi.fn()}
      />,
    );
    expect(
      screen.getByText('CARTO selected — tiles fall back to standard OSM'),
    ).toBeTruthy();
  });

  it('saving CARTO with a blank key saves tileProvider and shows the fallback hint', async () => {
    updateMock.mockResolvedValue(
      settingsFixture({ tileProvider: 'carto', cartoApiKey: '' }),
    );
    const onUpdate = vi.fn();
    renderCard(
      <MapBasemapCard settings={settingsFixture()} onUpdate={onUpdate} />,
    );

    await selectProvider('carto');
    // The draft-level hint is visible BEFORE saving — resolveTileTargets
    // degrades blank-key carto to OSM until a key is saved.
    expect(
      screen.getByText(/fall back to standard\s*OpenStreetMap until a key is saved/),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({
        tileProvider: 'carto',
        cartoApiKey: '',
      });
    });
    expect(onUpdate).toHaveBeenCalled();
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('saving a CARTO key PUTs it verbatim, masked, never rendered as text', async () => {
    updateMock.mockResolvedValue(
      settingsFixture({ tileProvider: 'carto', cartoApiKey: 'sekrit-key-42' }),
    );
    renderCard(<MapBasemapCard settings={settingsFixture()} onUpdate={vi.fn()} />);

    await selectProvider('carto');
    const keyInput = screen.getByLabelText('CARTO API key') as HTMLInputElement;
    // Masked input: the value can only be entered, never displayed as text.
    expect(keyInput.type).toBe('password');
    fireEvent.change(keyInput, { target: { value: 'sekrit-key-42' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({
        tileProvider: 'carto',
        cartoApiKey: 'sekrit-key-42',
      });
    });
  });

  it('saving OSM sends only the provider — the stored key is never touched', async () => {
    updateMock.mockResolvedValue(settingsFixture({ tileProvider: 'osm' }));
    renderCard(
      <MapBasemapCard
        // Stored under carto with a key: switching back to OSM must not
        // authorize overwriting the stored key.
        settings={settingsFixture({ tileProvider: 'carto', cartoApiKey: 'stored-key' })}
        onUpdate={vi.fn()}
      />,
    );

    await selectProvider('osm');
    expect(screen.queryByLabelText('CARTO API key')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledWith({ tileProvider: 'osm' });
    });
    // cartoApiKey absent from the body even though one is stored.
    expect(updateMock.mock.calls[0][0]).not.toHaveProperty('cartoApiKey');
  });

  it('surfaces a save failure inline and does not claim Saved', async () => {
    updateMock.mockRejectedValue(new Error('500'));
    renderCard(<MapBasemapCard settings={settingsFixture()} onUpdate={vi.fn()} />);

    await selectProvider('carto');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Failed to save map basemap settings.'),
    ).toBeTruthy();
    expect(screen.queryByText('Saved.')).toBeNull();
  });
});
