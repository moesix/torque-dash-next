// @vitest-environment jsdom
/**
 * Analysis History on the shared data layer (plan 035).
 *
 * Contracts under test:
 *  - rapid paging cannot render an older page's rows under a newer page's
 *    footer: each page is its own TanStack Query key, so a slow page-1
 *    response can never overwrite the page-3 cache entry (the manual
 *    `fetchAnalyses` had a last-response-wins race);
 *  - a successful delete invalidates the whole `['analyses']` prefix;
 *  - a failed list load surfaces the inline error and Retry refetches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AnalysisHistory from '@/components/ai/AnalysisHistory';
import type { AnalysisPreview } from '@/lib/types';

/** jsdom exposes HTMLDialogElement but not the modal methods ConfirmDialog
 *  needs (same shim AnalysisPanel's suite uses). */
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
  getAllAnalyses: vi.fn(),
  getAnalysis: vi.fn(),
  getVehicles: vi.fn(),
  deleteAnalysis: vi.fn(),
  exportAnalyses: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, ...apiMocks };
});

function preview(id: number, sessionName: string): AnalysisPreview {
  return {
    id,
    sessionId: id,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    createdAt: '2026-01-01T00:00:00.000Z',
    Session: { id, name: sessionName, vehicleId: null },
  };
}

function page(pageIndex: number, total = 60) {
  const label = ['zero', 'one', 'two'][pageIndex];
  return {
    analyses: [preview(pageIndex * 100 + 1, `Session ${label} 1`)],
    total,
    limit: 20,
    offset: pageIndex * 20,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderHistory() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  render(
    <QueryClientProvider client={client}>
      <AnalysisHistory />
    </QueryClientProvider>,
  );
  return client;
}

describe('AnalysisHistory data layer (jsdom)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getVehicles.mockResolvedValue([]);
    apiMocks.deleteAnalysis.mockResolvedValue(undefined);
    apiMocks.getAnalysis.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('badges a stored analysis with the units it was generated in; NULL is unbadged', async () => {
    apiMocks.getAllAnalyses.mockResolvedValue({
      analyses: [
        { ...preview(1, 'US session'), unitSystem: 'us' },
        { ...preview(2, 'Legacy session'), unitSystem: null },
      ],
      total: 2,
      limit: 20,
      offset: 0,
    });

    renderHistory();

    expect(await screen.findByText('US units')).toBeTruthy();
    const legacy = screen.getByText('Legacy session').closest('details') as HTMLElement;
    expect(within(legacy).queryByText('US units')).toBeNull();
    expect(within(legacy).queryByText('Metric')).toBeNull();
  });

  it('keeps page 3 when a stale page-1 response resolves afterwards', async () => {
    const page1 = deferred<ReturnType<typeof page>>();
    const page2 = deferred<ReturnType<typeof page>>();

    apiMocks.getAllAnalyses.mockImplementation(
      (_limit: number, offset: number) => {
        if (offset === 0) return Promise.resolve(page(0));
        if (offset === 20) return page1.promise;
        if (offset === 40) return page2.promise;
        return Promise.resolve(page(0));
      },
    );

    renderHistory();
    await screen.findByText('Session zero 1');

    // Next → page 1 (in flight), Next again → page 2 (in flight). The footer
    // stays at 3 pages because the cached total is shared.
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(apiMocks.getAllAnalyses).toHaveBeenCalledWith(20, 20, undefined),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(apiMocks.getAllAnalyses).toHaveBeenCalledWith(20, 40, undefined),
    );

    // Newest page resolves FIRST.
    page2.resolve(page(2));
    expect(await screen.findByText('Session two 1')).toBeTruthy();
    expect(screen.getByText(/Page 3 of 3/)).toBeTruthy();

    // The stale page-1 response lands afterwards — in its OWN cache key.
    page1.resolve(page(1));

    await waitFor(() => {
      expect(screen.getByText(/Page 3 of 3/)).toBeTruthy();
    });
    expect(screen.getByText('Session two 1')).toBeTruthy();
    expect(screen.queryByText('Session one 1')).toBeNull();
    expect(screen.queryByText('Session zero 1')).toBeNull();
  });

  it('invalidates the analyses prefix after a successful delete', async () => {
    apiMocks.getAllAnalyses.mockResolvedValue(page(0, 1));
    const client = renderHistory();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    await screen.findByText('Session zero 1');
    fireEvent.click(screen.getByRole('button', { name: 'Delete analysis' }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(apiMocks.deleteAnalysis).toHaveBeenCalledTimes(1));
    expect(apiMocks.deleteAnalysis).toHaveBeenCalledWith('1', 1);
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['analyses'] }),
    );
  });

  it('surfaces a load error and refetches on Retry', async () => {
    apiMocks.getAllAnalyses
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(page(0));

    renderHistory();

    expect(await screen.findByText(/Failed to load analyses\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Session zero 1')).toBeTruthy();
    expect(screen.queryByText(/Failed to load analyses\./)).toBeNull();
  });
});
