// @vitest-environment jsdom
/**
 * Behavior tests for the Settings control plane (SettingsPage.tsx).
 *
 * Contract under test:
 * - Admin vs non-admin rendering: only admins see the upload-token, retention
 *   and analysis-retention cards; non-admins see the managed-by-admin notice.
 *   This also guards plan 030's projection change (isAdmin is session-derived).
 * - Upload-token lifecycle: generating calls the API once and renders the
 *   one-time token exactly once; clearing it removes the token from the DOM.
 * - Env-managed tokens (`tokenFromEnv`) cannot be generated.
 * - Retention switch and analysis-retention select PUT the expected values.
 * - A rejected retention write surfaces the API message and re-reads full
 *   settings.
 *
 * The admin cards (AI provider / map basemap) have their own suites; they are
 * stubbed here so this file stays on the page-level control plane.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SettingsPage from '../SettingsPage';
import {
  ApiError,
  getFullSettings,
  getPreferences,
  updateSettings,
  generateUploadToken,
} from '@/lib/api';
import type { Settings } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
  getFullSettings: vi.fn(),
  updateSettings: vi.fn(),
  generateUploadToken: vi.fn(),
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));

vi.mock('@/lib/useVersion', () => ({
  useVersion: () => ({ version: '' }),
}));

vi.mock('../AiProviderCard', () => ({
  default: () => <div data-testid="ai-provider-card" />,
}));
vi.mock('../MapBasemapCard', () => ({
  default: () => <div data-testid="map-basemap-card" />,
}));
vi.mock('../VehicleManager', () => ({
  default: () => <div data-testid="vehicle-manager" />,
}));
vi.mock('@/components/ai/AnalysisHistory', () => ({
  default: () => <div data-testid="analysis-history" />,
}));

const getFullMock = vi.mocked(getFullSettings);
const updateMock = vi.mocked(updateSettings);
const generateMock = vi.mocked(generateUploadToken);
const getPreferencesMock = vi.mocked(getPreferences);

function settingsFixture(overrides: Partial<Settings> = {}): Settings {
  return {
    disableRegistration: false,
    hasUploadApiToken: false,
    tokenFromEnv: false,
    isAdmin: true,
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

/** Resolve the initial load and wait for the admin gate to settle. */
async function renderLoaded(settings: Settings) {
  getFullMock.mockResolvedValue(settings);
  getPreferencesMock.mockResolvedValue({
    unitSystem: 'metric',
    serverDefault: 'metric',
    preference: null,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
  // The page renders nothing admin-only until getFullSettings resolves.
  await screen.findByText('Settings');
  return settings;
}

describe('SettingsPage (jsdom)', () => {
  beforeEach(() => {
    getFullMock.mockReset();
    updateMock.mockReset();
    generateMock.mockReset();
    getPreferencesMock.mockReset();
    updateMock.mockResolvedValue(settingsFixture());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('admin: generates a token once and renders it exactly once', async () => {
    await renderLoaded(settingsFixture({ isAdmin: true, hasUploadApiToken: false }));
    generateMock.mockResolvedValue({ uploadApiToken: 'tok-once-123' });

    await screen.findByText('Upload API Token');
    fireEvent.click(screen.getByRole('button', { name: 'Generate New Token' }));

    // getByText throws if the token is rendered more than once.
    await waitFor(() => expect(screen.getByText('tok-once-123')).toBeTruthy());
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('tok-once-123')).toHaveLength(1);

    // Clearing removes the one-time token from the DOM.
    updateMock.mockResolvedValue(settingsFixture({ hasUploadApiToken: false }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear Token' }));

    await waitFor(() => expect(screen.queryByText('tok-once-123')).toBeNull());
    expect(updateMock).toHaveBeenCalledWith({ uploadApiToken: null });
  });

  it('admin, env-managed: generate is disabled and clear is not offered', async () => {
    await renderLoaded(
      settingsFixture({ isAdmin: true, hasUploadApiToken: true, tokenFromEnv: true }),
    );

    await screen.findByText('Upload API Token');
    expect(
      (screen.getByRole('button', { name: 'Generate New Token' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Clear Token' })).toBeNull();
    expect(screen.getByText(/UPLOAD_API_TOKEN/)).toBeTruthy();
  });

  it('non-admin: shows the managed-by-admin notice and no admin cards', async () => {
    await renderLoaded(settingsFixture({ isAdmin: false }));

    await screen.findByText('Server settings are managed by the administrator.');
    expect(screen.queryByText('Upload API Token')).toBeNull();
    expect(screen.queryByText('Disable registration')).toBeNull();
    expect(screen.queryByText('Data Retention')).toBeNull();
    expect(screen.queryByText('Analysis Retention')).toBeNull();
    expect(screen.queryByTestId('ai-provider-card')).toBeNull();
    expect(screen.queryByTestId('map-basemap-card')).toBeNull();
  });

  it('retention toggle PUTs retentionEnabled and reveals the day select', async () => {
    await renderLoaded(settingsFixture({ isAdmin: true, retentionEnabled: false }));

    const toggle = await screen.findByRole('switch', { name: 'Enable auto-cleanup' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({ retentionEnabled: true }),
    );
    expect(await screen.findByLabelText('Keep data for:')).toBeTruthy();
  });

  it('retention toggle failure shows the API message and re-reads full settings', async () => {
    await renderLoaded(settingsFixture({ isAdmin: true, retentionEnabled: false }));
    expect(getFullMock).toHaveBeenCalledTimes(1);

    updateMock.mockRejectedValue(new ApiError('Retention is locked', 400));
    fireEvent.click(await screen.findByRole('switch', { name: 'Enable auto-cleanup' }));

    // The shared retentionError is rendered in both retention cards.
    expect((await screen.findAllByText('Retention is locked')).length).toBeGreaterThan(0);
    await waitFor(() => expect(getFullMock).toHaveBeenCalledTimes(2));
  });

  it('analysis-retention select PUTs the numeric value and null for Off', async () => {
    await renderLoaded(settingsFixture({ isAdmin: true, analysisRetentionDays: null }));

    const select = await screen.findByLabelText('Prune analyses older than:');
    fireEvent.change(select, { target: { value: '90' } });
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({ analysisRetentionDays: 90 }),
    );

    updateMock.mockClear();
    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith({ analysisRetentionDays: null }),
    );
  });
});
