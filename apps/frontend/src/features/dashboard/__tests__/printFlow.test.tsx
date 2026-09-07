// @vitest-environment jsdom
/**
 * Regression tests for the ReplayDashboard print state machine
 * (plans 104 + 109).
 *
 * The state machine under test, as implemented in ReplayDashboard.tsx:
 *
 *   handlePrint()
 *     setIsPrinting(true); setPrintMode(true);
 *     raf1 → raf2 (double-rAF, ids stored in printRafRef) → window.print()
 *   reset effect (armed while isPrinting)
 *     - re-arms printInvokedRef.current = false
 *     - window 'afterprint' → finishPrint() (clear printMode + isPrinting)
 *     - 500ms setTimeout fallback → finishPrint() ONLY if
 *       printInvokedRef.current is true (a backgrounded tab stalls rAF; the
 *       fallback must not collapse the report before the print was invoked)
 *     - cleanup: remove listener, clear timeout, cancel pending rAFs
 *   unmount-only effect → cancels any pending rAFs
 *
 * Observables exercised through the REAL dashboard chrome (not a mirror):
 *   - window.print() invocation after exactly two rAF ticks
 *   - the print button's disabled state (isPrinting)
 *   - DiagnosticPanel forceExpanded propagation (aria-expanded on the
 *     "Engine RPM & Vehicle Speed" panel header — printMode drives it)
 *
 * Mount strategy: ReplayDashboard is mounted for real inside a MemoryRouter.
 * Only its data/IO layer is faked (4 logical modules):
 *   1. useSessionTelemetry        — fixed session + frames (no react-query)
 *   2. echarts (4 specifiers)     — jsdom has no canvas; init/resize/dispose
 *                                  are stubbed (same intent as mapView.test.ts
 *                                  mocking leaflet)
 *   3. GpsTrackMap                — leaflet-bound; not part of this machine
 *   4. AnalysisPanel (lazy)       — react-markdown/highlight stack; not part
 *                                  of this machine
 *
 * Determinism: requestAnimationFrame is bridged to setTimeout(0) so vitest's
 * fake timers control both the double-rAF chain and the 500ms fallback from
 * one clock. cancelAnimationFrame is bridged to clearTimeout to keep stored
 * rAF ids cancelable under that same clock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Session, TelemetryFrame } from '@/lib/types';

// ── Mocks (data/IO layer only) ─────────────────────────────────────────────

// Fixture data + echarts spies need to be referencable from vi.mock factories,
// which vitest hoists above imports — hence vi.hoisted.
const telemetry = vi.hoisted(() => {
  const session: Session = {
    id: 's1',
    name: 'Test Session',
    vehicleName: 'Test Car',
    userId: 1,
    startDate: '2026-01-01T00:00:00.000Z',
    notes: null,
    vehicleId: 1,
  };
  const mk = (ts: string, rpm: number, speed: number): TelemetryFrame => ({
    timestamp: ts,
    lon: null,
    lat: null,
    values: { kc: 0, k5: 80 },
    engineRpm: rpm,
    vehicleSpeed: speed,
  });
  const frames: TelemetryFrame[] = [
    mk('2026-01-01T00:00:00.000Z', 800, 0),
    mk('2026-01-01T00:00:01.000Z', 1500, 30),
    mk('2026-01-01T00:00:02.000Z', 2500, 60),
  ];
  return { session, frames };
});

const echartsMocks = vi.hoisted(() => {
  const chart = () => ({
    setOption: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  });
  return {
    init: vi.fn(() => chart()),
    use: vi.fn(),
  };
});

vi.mock('@/features/dashboard/hooks/useSessionTelemetry', () => ({
  useSessionTelemetry: () => ({
    session: telemetry.session,
    frames: telemetry.frames,
    isLoading: false,
    error: null,
    truncated: false,
  }),
}));

// echarts/core + tree-shaken submodule specifiers (the same set the chart
// components import). jsdom has no canvas, so charts are never really inited.
vi.mock('echarts/core', () => ({
  init: echartsMocks.init,
  use: echartsMocks.use,
}));
vi.mock('echarts/charts', () => ({ LineChart: {} }));
vi.mock('echarts/components', () => ({
  GridComponent: {},
  TooltipComponent: {},
  MarkLineComponent: {},
  MarkAreaComponent: {},
  DataZoomComponent: {},
  DataZoomSliderComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

// Leaflet-bound GPS map — unrelated to the print machine. Mocking the module
// (rather than leaflet/react-leaflet) keeps the heavy lib out of the graph.
vi.mock('@/components/map/GpsTrackMap', () => ({
  __esModule: true,
  default: () => null,
}));

// The AI panel is React.lazy + react-markdown/rehype-highlight + API calls.
// printMode IS threaded into it (body fetch), but its print behavior is out
// of scope here; stub it so the Suspense boundary resolves cheaply.
vi.mock('@/components/ai/AnalysisPanel', () => ({
  __esModule: true,
  default: function AnalysisPanelStub() {
    return null;
  },
}));

// ReplayDashboard is only imported AFTER the mocks above are registered.
import ReplayDashboard from '@/features/dashboard/ReplayDashboard';

// ── Harness helpers ─────────────────────────────────────────────────────────

/** jsdom has no ResizeObserver; chart components construct one on init. */
class ResizeObserverShim {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** jsdom exposes HTMLDialogElement but not showModal()/close(). AnalysisConfirmDialog
 *  (mounted by ReplayDashboard, always rendered when closed) calls dialog.close()
 *  from a mount effect, so the methods are shimmed for the test environment. */
function shimHtmlDialogMethods() {
  const proto = window.HTMLDialogElement?.prototype as
    | (HTMLDialogElement & {
        showModal?: () => void;
        close?: () => void;
      })
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

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/sessions/s1']}>
      <Routes>
        <Route path="/sessions/:id" element={<ReplayDashboard />} />
      </Routes>
    </MemoryRouter>,
  );
}

function printButton() {
  return screen.getByRole('button', { name: 'Print session report' });
}

/** Header of the always-rendered "Engine RPM & Vehicle Speed" diagnostic
 *  panel — forceExpanded={printMode} is observable via its aria-expanded. */
function rpmPanelHeader() {
  return screen.getByRole('button', {
    name: /Engine RPM & Vehicle Speed/,
  });
}

const PRINT_BUTTON_TEXT = '🖨️ Print / PDF';

describe('ReplayDashboard print state machine (jsdom)', () => {
  let printSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // rAF → faked setTimeout(0): one fake clock drives the double-rAF chain
    // AND the 500ms fallback deterministically.
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: FrameRequestCallback) =>
        setTimeout(() => cb(0), 0) as unknown as number,
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      (id: number) => clearTimeout(id),
    );
    vi.stubGlobal('ResizeObserver', ResizeObserverShim);
    shimHtmlDialogMethods();
    printSpy = vi.fn();
    // jsdom exposes window.print only as a "not implemented" stub; replace it
    // with an observable spy.
    Object.defineProperty(window, 'print', {
      value: printSpy,
      configurable: true,
      writable: true,
    });
    echartsMocks.init.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('invokes window.print after the double-rAF chain and force-expands panels meanwhile', () => {
    renderDashboard();

    // Dash mode, printing idle → panel collapsed, button enabled.
    expect(rpmPanelHeader().getAttribute('aria-expanded')).toBe('false');
    expect((printButton() as HTMLButtonElement).disabled).toBe(false);
    expect(within(printButton()).queryByText(PRINT_BUTTON_TEXT)).not.toBeNull();

    fireEvent.click(printButton());

    // isPrinting + printMode commit synchronously: button disabled/spinner,
    // panels force-expanded — before window.print has run (rAF pending).
    expect((printButton() as HTMLButtonElement).disabled).toBe(true);
    expect(within(printButton()).queryByText(PRINT_BUTTON_TEXT)).toBeNull();
    expect(rpmPanelHeader().getAttribute('aria-expanded')).toBe('true');
    expect(printSpy).not.toHaveBeenCalled();

    // Two rAF ticks (bridged to faked timeouts at t=0) fire window.print().
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(printSpy).toHaveBeenCalledTimes(1);

    // Still printing until the dialog closes (afterprint below).
    expect((printButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('resets on window afterprint (spinner cleared, panels collapsed, print re-enabled)', () => {
    renderDashboard();

    fireEvent.click(printButton());
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(rpmPanelHeader().getAttribute('aria-expanded')).toBe('true');

    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });

    expect((printButton() as HTMLButtonElement).disabled).toBe(false);
    expect(within(printButton()).queryByText(PRINT_BUTTON_TEXT)).not.toBeNull();
    expect(rpmPanelHeader().getAttribute('aria-expanded')).toBe('false');
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('500ms fallback no-ops while rAF is stalled (print never invoked) — afterprint still resets', () => {
    renderDashboard();

    // Backgrounded tab: rAF never fires its callback → window.print never
    // invoked → printInvokedRef stays false.
    vi.stubGlobal('requestAnimationFrame', () => 0);

    fireEvent.click(printButton());
    expect((printButton() as HTMLButtonElement).disabled).toBe(true);
    expect(rpmPanelHeader().getAttribute('aria-expanded')).toBe('true');

    // 600ms elapses with no print invoked: the gated fallback must NOT
    // collapse the report mid-flight.
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(printSpy).not.toHaveBeenCalled();
    expect((printButton() as HTMLButtonElement).disabled).toBe(true);
    expect(rpmPanelHeader().getAttribute('aria-expanded')).toBe('true');

    // The real reset path (afterprint) still works while printing.
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect((printButton() as HTMLButtonElement).disabled).toBe(false);
    expect(rpmPanelHeader().getAttribute('aria-expanded')).toBe('false');
  });

  it('500ms fallback resets after window.print was invoked (engines with no afterprint)', () => {
    renderDashboard();

    fireEvent.click(printButton());
    // rAF chain fires → window.print invoked (afterprint never dispatched).
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(printSpy).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect((printButton() as HTMLButtonElement).disabled).toBe(false);
    expect(within(printButton()).queryByText(PRINT_BUTTON_TEXT)).not.toBeNull();
    expect(rpmPanelHeader().getAttribute('aria-expanded')).toBe('false');
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('unmount mid-rAF cancels the pending chain so window.print never fires', () => {
    const cancelSpy = vi.fn((id: number) => clearTimeout(id));
    vi.stubGlobal('cancelAnimationFrame', cancelSpy);

    const { unmount } = renderDashboard();
    fireEvent.click(printButton());

    // Navigate away before any rAF tick: both cleanups cancel the stored ids.
    act(() => {
      unmount();
    });
    expect(cancelSpy).toHaveBeenCalled();

    // Let time pass — the cancelled chain must not reach window.print().
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(printSpy).not.toHaveBeenCalled();
  });
});
