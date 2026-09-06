// @vitest-environment jsdom
/**
 * Regression tests for the analysis delete flow in AnalysisPanel (MINOR #12).
 *
 * Finding: a rapid double-click on the Delete button fired two DELETEs; the
 * second 404'd on the now-missing row and surfaced a spurious error.
 *
 * Contract under test, as implemented in AnalysisPanel.tsx:
 *   - handleDeleteAnalysis early-returns while deletingId === preview.id, so a
 *     second click on the same row cannot fire a duplicate DELETE.        (L99)
 *   - the row's Delete button is disabled + aria-busy while that row is being
 *     deleted, and reads "Deleting…".
 *   - a 404 ApiError is treated as already-deleted SUCCESS (row dropped
 *     locally, no error surfaced) rather than a failure.                  (L119)
 *   - non-404 errors still surface the per-row "Failed to delete analysis."
 *     message.
 *
 * The real component is mounted with the API module mocked (listAnalyses →
 * one preview row; deleteAnalysis → programmable). No expansion happens, so
 * the react-markdown/rehype-highlight stack is never exercised. window.confirm
 * is stubbed to auto-accept.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { usePlaybackStore } from '@/app/playbackStore';
import AnalysisPanel from '@/components/ai/AnalysisPanel';
import { ApiError } from '@/lib/api';
import type { AnalysisPreview } from '@/lib/types';

// Programmable API mocks — hoisted so the vi.mock factory can reference them.
const apiMocks = vi.hoisted(() => ({
  deleteAnalysis: vi.fn(),
  listAnalyses: vi.fn(),
  getFullSettings: vi.fn(),
  getAnalysis: vi.fn(),
  analyzeSession: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    deleteAnalysis: apiMocks.deleteAnalysis,
    listAnalyses: apiMocks.listAnalyses,
    getFullSettings: apiMocks.getFullSettings,
    getAnalysis: apiMocks.getAnalysis,
    analyzeSession: apiMocks.analyzeSession,
  };
});

const PREVIEW: AnalysisPreview = {
  id: 42,
  sessionId: 7,
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** The Delete button for the single analysis row. Its accessible name is the
 *  static aria-label "Delete analysis"; the visible text toggles Delete /
 *  Deleting… while the row is in flight. */
function deleteButton() {
  return screen.getByRole('button', { name: 'Delete analysis' }) as HTMLButtonElement;
}

describe('AnalysisPanel delete flow (jsdom)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getFullSettings.mockResolvedValue({ hasLlmProvider: true });
    apiMocks.listAnalyses.mockResolvedValue([PREVIEW]);
    apiMocks.deleteAnalysis.mockResolvedValue(undefined);
    // Auto-accept the confirm dialog so delete proceeds without a click.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    usePlaybackStore.setState({ cursorTime: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    usePlaybackStore.setState({ cursorTime: null });
  });

  it('disables the Delete button while a delete is in flight (no double DELETE)', async () => {
    let releaseDelete: (() => void) | undefined;
    apiMocks.deleteAnalysis.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDelete = resolve;
        }),
    );

    render(<AnalysisPanel sessionId="s1" />);
    // Past analyses load async; wait for the Delete row to appear.
    const btn = await screen.findByRole('button', { name: 'Delete analysis' });

    fireEvent.click(btn);

    await waitFor(() => {
      expect(apiMocks.deleteAnalysis).toHaveBeenCalledTimes(1);
    });
    // While in flight: the row's Delete button is disabled + aria-busy and its
    // visible text flips to "Deleting…" (the aria-label stays "Delete analysis",
    // which is the accessible name — so assert textContent, not role name).
    await waitFor(() => {
      const busyBtn = deleteButton();
      expect(busyBtn.disabled).toBe(true);
      expect(busyBtn.getAttribute('aria-busy')).toBe('true');
      expect(busyBtn.textContent).toBe('Deleting…');
    });

    // A second click while in flight must be ignored — still one DELETE.
    fireEvent.click(deleteButton());
    expect(apiMocks.deleteAnalysis).toHaveBeenCalledTimes(1);

    releaseDelete?.();
    // After resolve the row disappears from the list.
    await waitFor(() => {
      expect(screen.queryByText(/deepseek-v4-flash/)).toBeNull();
    });
  });

  it('treats a 404 ApiError as already-deleted success (no spurious error)', async () => {
    apiMocks.deleteAnalysis.mockRejectedValue(new ApiError('Request failed with status 404', 404));

    render(<AnalysisPanel sessionId="s1" />);
    const btn = await screen.findByRole('button', { name: 'Delete analysis' });

    fireEvent.click(btn);

    // The row is removed from the list as if the delete succeeded.
    await waitFor(() => {
      expect(screen.queryByText(/deepseek-v4-flash/)).toBeNull();
    });
    expect(screen.queryByText('Failed to delete analysis.')).toBeNull();
    expect(apiMocks.deleteAnalysis).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-404 error and keeps the row', async () => {
    apiMocks.deleteAnalysis.mockRejectedValue(new ApiError('Request failed with status 500', 500));

    render(<AnalysisPanel sessionId="s1" />);
    const btn = await screen.findByRole('button', { name: 'Delete analysis' });

    fireEvent.click(btn);

    const err = await screen.findByText('Failed to delete analysis.');
    expect(err).toBeTruthy();
    // Row still listed.
    expect(screen.queryByText(/deepseek-v4-flash/)).not.toBeNull();
    // Button re-enabled after the failed attempt.
    await waitFor(() => {
      expect(deleteButton().disabled).toBe(false);
    });
  });
});
