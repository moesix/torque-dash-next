// @vitest-environment jsdom
/**
 * Plan 037 step 2: the expanded-chart <dialog> stays mounted (it owns
 * `closedby` + the ref) but its OverlayChart only mounts while the dialog is
 * open — a closed <dialog> is display:none, so a chart in there is pure waste.
 *
 * Observables through the REAL dashboard:
 *   - closed dialog: no chart container inside it, echarts.init count stays 1
 *     (the always-visible main chart)
 *   - clicking "Expand chart": dialog opens, exactly one more chart container
 *     appears and echarts.init runs exactly once more
 *   - clicking "Collapse chart": the container and the extra instance go away
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Session, TelemetryFrame } from '@/lib/types';

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
    values: { kc: rpm, k5: 80 },
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
  const charts: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
  const init = vi.fn(() => {
    const chart = {
      setOption: vi.fn(),
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    charts.push(chart);
    return chart;
  });
  return { init, charts };
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

vi.mock('echarts/core', () => ({
  init: echartsMocks.init,
  use: vi.fn(),
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
vi.mock('@/components/map/GpsTrackMap', () => ({
  __esModule: true,
  default: () => null,
}));
vi.mock('@/components/ai/AnalysisPanel', () => ({
  __esModule: true,
  default: function AnalysisPanelStub() {
    return null;
  },
}));

import ReplayDashboard from '@/features/dashboard/ReplayDashboard';

class ResizeObserverShim {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

/** The OverlayChart's container is the only `w-full min-w-0` div in the dialog. */
function dialogChartContainers() {
  const dialog = document.querySelector('dialog[aria-label="Expanded chart"]');
  expect(dialog).not.toBeNull();
  return dialog!.querySelectorAll('div.w-full.min-w-0');
}

describe('expanded chart mounts only while the dialog is open', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverShim);
    shimHtmlDialogMethods();
    echartsMocks.init.mockClear();
    echartsMocks.charts.length = 0;
    render(
      <MemoryRouter initialEntries={['/sessions/s1']}>
        <Routes>
          <Route path="/sessions/:id" element={<ReplayDashboard />} />
        </Routes>
      </MemoryRouter>,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('closed dialog has no chart and does not init a second ECharts instance', () => {
    // Only the always-visible main chart initialized.
    expect(echartsMocks.init).toHaveBeenCalledTimes(1);
    expect(dialogChartContainers()).toHaveLength(0);
    // The dialog element itself is still mounted (it owns closedby + ref).
    expect(
      document.querySelector('dialog[aria-label="Expanded chart"]'),
    ).not.toBeNull();
  });

  it('expanding mounts exactly one chart; collapsing unmounts and disposes it', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Expand chart' }));

    expect(dialogChartContainers()).toHaveLength(1);
    expect(echartsMocks.init).toHaveBeenCalledTimes(2);

    const expandedChart = echartsMocks.charts[1];
    expect(expandedChart.dispose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse chart' }));

    expect(dialogChartContainers()).toHaveLength(0);
    // The dialog stays mounted after closing.
    expect(
      document.querySelector('dialog[aria-label="Expanded chart"]'),
    ).not.toBeNull();
    expect(expandedChart.dispose).toHaveBeenCalled();
  });

  it('reopening initializes a fresh instance (not a stale zero-size one)', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Expand chart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse chart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand chart' }));

    expect(dialogChartContainers()).toHaveLength(1);
    // main + first expand + second expand
    expect(echartsMocks.init).toHaveBeenCalledTimes(3);
  });
});
