// @vitest-environment jsdom
/**
 * Behavior tests for the "AI Provider" admin card (AiProviderCard.tsx).
 *
 * Contract under test (plans/032):
 * - Switching provider resets the local model draft (the hidden state bug).
 * - Saving after a switch sends `llmModel: null` so the server clears the
 *   previous provider's model instead of retaining it (which surfaced as a
 *   generic 404 from the new provider).
 * - `llmEndpoint` is only sent for providers that use a custom endpoint
 *   (custom / ollama); switching to a hosted provider sends null to clear a
 *   stale endpoint (which may embed URL userinfo).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AiProviderCard from '../AiProviderCard';
import { updateLlmSettings, testLlmConnection } from '@/lib/api';
import type { Settings } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  updateLlmSettings: vi.fn(),
  testLlmConnection: vi.fn(),
}));

const updateMock = vi.mocked(updateLlmSettings);
const testMock = vi.mocked(testLlmConnection);

function settingsFixture(overrides: Partial<Settings> = {}): Settings {
  return {
    disableRegistration: false,
    hasUploadApiToken: false,
    tokenFromEnv: false,
    hasLlmProvider: true,
    llmProvider: 'openai',
    llmModel: 'gpt-4o',
    llmEndpoint: null,
    hasLlmApiKey: true,
    vehicleMake: null,
    vehicleModel: null,
    vehicleYear: null,
    engineCc: null,
    llmThinkingMode: true,
    llmReasoningEffort: 'high',
    llmMaxTokens: 16384,
    timezoneOffset: 0,
    retentionEnabled: false,
    retentionDays: 365,
    analysisRetentionDays: null,
    tileProvider: 'osm',
    ...overrides,
  };
}

async function selectProvider(value: string) {
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value } });
}

describe('AiProviderCard (jsdom)', () => {
  beforeEach(() => {
    updateMock.mockReset();
    testMock.mockReset();
    updateMock.mockResolvedValue(settingsFixture());
  });

  it('switching provider saves null model and null endpoint', async () => {
    const onUpdate = vi.fn();
    render(<AiProviderCard settings={settingsFixture()} onUpdate={onUpdate} />);

    // OpenAI → DeepSeek: the previous provider's model is now invalid.
    await selectProvider('deepseek');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    const body = updateMock.mock.calls[0][0];
    expect(body).toMatchObject({
      llmProvider: 'deepseek',
      llmModel: null,
      llmEndpoint: null,
    });
    // DeepSeek-only knobs are still sent; no API key was typed.
    expect(body.llmThinkingMode).toBe(true);
    expect(body).not.toHaveProperty('llmApiKey');
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('clears a stale endpoint when switching from custom to a hosted provider', async () => {
    render(
      <AiProviderCard
        settings={settingsFixture({
          llmProvider: 'custom',
          llmModel: 'my-model',
          llmEndpoint: 'http://10.0.0.2:8080/v1',
        })}
        onUpdate={vi.fn()}
      />,
    );

    await selectProvider('openai');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      llmProvider: 'openai',
      llmModel: null,
      llmEndpoint: null,
    });
  });

  it('keeps the endpoint for providers that need one (custom)', async () => {
    render(
      <AiProviderCard
        settings={settingsFixture({
          llmProvider: 'custom',
          llmModel: 'my-model',
          llmEndpoint: 'https://proxy.example.com/v1',
        })}
        onUpdate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0][0]).toMatchObject({
      llmProvider: 'custom',
      llmModel: 'my-model',
      llmEndpoint: 'https://proxy.example.com/v1',
    });
  });
});
