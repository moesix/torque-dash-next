// @vitest-environment jsdom
/**
 * Contract regression tests for DiagnosticPanel's lazy-init / forceExpanded
 * behavior (plans 100 + 109).
 *
 * The contract, as implemented in DiagnosticPanel.tsx:
 *
 *   isExpanded = forceExpanded || expanded            (line 107)
 *   lazy-init effect [isExpanded]:
 *     if (!isExpanded || hasInitRef.current) return;  → echarts.init ONLY on
 *                                                       first expansion
 *     ... const chart = echarts.init(el); ...
 *     return () => { ro.disconnect(); chart.dispose(); ... }  → disposal
 *                                                       happens when React
 *                                                       runs the effect's
 *                                                       cleanup: when an
 *                                                       expanded panel
 *                                                       collapses OR when it
 *                                                       unmounts while
 *                                                       expanded.
 *
 * These tests assert observable effects on the real component against a
 * stubbed echarts module (jsdom has no canvas): when echarts.init is called,
 * that the instance survives re-renders, and when dispose runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TelemetryFrame } from '@/lib/types';

// ── echarts mock (needs hoisting for factory references) ───────────────────

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

import DiagnosticPanel from '@/components/charts/DiagnosticPanel';

// ── Fixtures + harness ──────────────────────────────────────────────────────

class ResizeObserverShim {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mk = (ts: string, speed: number): TelemetryFrame => ({
  timestamp: ts,
  lon: null,
  lat: null,
  values: {},
  engineRpm: null,
  vehicleSpeed: speed,
});

const framesA: TelemetryFrame[] = [
  mk('2026-01-01T00:00:00.000Z', 0),
  mk('2026-01-01T00:00:01.000Z', 30),
];
const framesB: TelemetryFrame[] = [
  mk('2026-01-01T00:00:00.000Z', 10),
  mk('2026-01-01T00:00:01.000Z', 40),
  mk('2026-01-01T00:00:02.000Z', 70),
];

const pids = ['vehicleSpeed'] as const;

function renderPanel(props: {
  forceExpanded?: boolean;
  defaultCollapsed?: boolean;
  frames?: TelemetryFrame[];
}) {
  return render(
    <DiagnosticPanel
      title="Test Panel"
      frames={props.frames ?? framesA}
      pids={pids}
      forceExpanded={props.forceExpanded ?? false}
      defaultCollapsed={props.defaultCollapsed ?? true}
    />,
  );
}

function headerButton() {
  return screen.getByRole('button', { name: /Test Panel/ });
}

function firstChartStub() {
  // Every echarts.init(el) call returns a fresh stub chart object.
  const charts = echartsMocks.init.mock.results.map((r) => r.value);
  if (charts.length === 0) throw new Error('echarts.init was never called');
  return charts[0];
}

describe('DiagnosticPanel forceExpanded init contract (jsdom)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverShim);
    echartsMocks.init.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does NOT init a chart while collapsed by default', () => {
    renderPanel({});
    expect(headerButton().getAttribute('aria-expanded')).toBe('false');
    expect(echartsMocks.init).not.toHaveBeenCalled();
  });

  it('inits once on first expansion and the instance survives re-renders', () => {
    const { rerender } = renderPanel({ forceExpanded: true });
    expect(headerButton().getAttribute('aria-expanded')).toBe('true');
    expect(echartsMocks.init).toHaveBeenCalledTimes(1);

    const chart = firstChartStub();
    expect(chart.dispose).not.toHaveBeenCalled();

    // Re-renders (e.g. new frames arriving from the query cache) must not
    // recreate the chart — only re-issue setOption on the live instance.
    rerender(
      <DiagnosticPanel
        title="Test Panel"
        frames={framesB}
        pids={pids}
        forceExpanded
        defaultCollapsed
      />,
    );
    expect(echartsMocks.init).toHaveBeenCalledTimes(1);
    expect(chart.dispose).not.toHaveBeenCalled();
    expect(chart.setOption).toHaveBeenCalled();
  });

  it('forceExpanded false→true→false: init once total, dispose when expansion ends', () => {
    const { rerender } = renderPanel({}); // false — collapsed, nothing inited
    expect(echartsMocks.init).not.toHaveBeenCalled();

    rerender(
      <DiagnosticPanel
        title="Test Panel"
        frames={framesA}
        pids={pids}
        forceExpanded
        defaultCollapsed
      />,
    );
    expect(echartsMocks.init).toHaveBeenCalledTimes(1);
    const chart = firstChartStub();

    // Force-expansion ends → effect cleanup runs → chart disposed exactly once.
    rerender(
      <DiagnosticPanel
        title="Test Panel"
        frames={framesA}
        pids={pids}
        forceExpanded={false}
        defaultCollapsed
      />,
    );
    expect(headerButton().getAttribute('aria-expanded')).toBe('false');
    expect(chart.dispose).toHaveBeenCalledTimes(1);
    expect(echartsMocks.init).toHaveBeenCalledTimes(1);

    // A collapsed panel holds no cleanup, so unmount does not double-dispose.
    expect(chart.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the chart on unmount while still force-expanded', () => {
    const { unmount } = renderPanel({ forceExpanded: true });
    expect(echartsMocks.init).toHaveBeenCalledTimes(1);
    const chart = firstChartStub();
    expect(chart.dispose).not.toHaveBeenCalled();

    unmount();
    expect(chart.dispose).toHaveBeenCalledTimes(1);
  });

  it('local header toggle lazy-inits the same way (userEvent path)', async () => {
    const user = userEvent.setup();
    renderPanel({});

    expect(echartsMocks.init).not.toHaveBeenCalled();
    await user.click(headerButton()); // expand
    expect(headerButton().getAttribute('aria-expanded')).toBe('true');
    expect(echartsMocks.init).toHaveBeenCalledTimes(1);

    await user.click(headerButton()); // collapse again
    expect(firstChartStub().dispose).toHaveBeenCalledTimes(1);

    // Expanding again re-inits (hasInitRef reset by the cleanup) — the panel
    // is usable after a collapse/expand cycle.
    fireEvent.click(headerButton());
    expect(echartsMocks.init).toHaveBeenCalledTimes(2);
  });
});
