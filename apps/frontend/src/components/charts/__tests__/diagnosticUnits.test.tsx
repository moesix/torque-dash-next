// @vitest-environment jsdom
/**
 * Plan 045 — the coolant diagnostic panel's 60–95 °C bounds convert with the
 * axis. Metric must stay exactly 60/95 (no gridline change); US becomes
 * 140–203 °F so the trace is not clipped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { TelemetryFrame, UserPreferences } from '@/lib/types';

const apiMocks = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, ...apiMocks };
});

const echartsMocks = vi.hoisted(() => {
  const charts: Array<{ option: any }> = [];
  const init = vi.fn(() => {
    const rec: { option: any } = { option: undefined };
    charts.push(rec);
    return {
      setOption: (opt: any) => { rec.option = opt; },
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
  });
  return { init, charts };
});

vi.mock('echarts/core', () => ({ init: echartsMocks.init, use: vi.fn() }));
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

import DiagnosticPanels from '@/components/charts/DiagnosticPanels';
import { UnitSystemProvider } from '@/app/unitSystem';
import { getAvailableSeries } from '@/lib/pidDecode';

class ResizeObserverShim {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const frames: TelemetryFrame[] = [
  {
    timestamp: '2026-01-01T00:00:00.000Z',
    lon: null,
    lat: null,
    values: { kc: 900, k5: 85 },
    engineRpm: 900,
    vehicleSpeed: 0,
  },
  {
    timestamp: '2026-01-01T00:00:01.000Z',
    lon: null,
    lat: null,
    values: { kc: 1200, k5: 90 },
    engineRpm: 1200,
    vehicleSpeed: 10,
  },
];
const available = getAvailableSeries(frames);

function renderPanels(prefs: UserPreferences) {
  apiMocks.getPreferences.mockResolvedValue(prefs);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UnitSystemProvider>
        <DiagnosticPanels frames={frames} available={available} forceExpanded />
      </UnitSystemProvider>
    </QueryClientProvider> as ReactElement,
  );
}

function coolantBounds() {
  return echartsMocks.charts
    .map((c) => c.option)
    .filter(Boolean)
    .map((o) => o.yAxis?.[0])
    .find((y: any) => y && y.min !== undefined && y.max !== undefined);
}

describe('DiagnosticPanels coolant bounds', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverShim);
    echartsMocks.charts.length = 0;
    echartsMocks.init.mockClear();
    apiMocks.getPreferences.mockReset();
  });

  it('metric keeps 60–95 unchanged', async () => {
    renderPanels({ unitSystem: 'metric', serverDefault: 'metric', preference: null });
    await waitFor(() => expect(coolantBounds()).toBeTruthy());
    const y = coolantBounds();
    expect(y.min).toBe(60);
    expect(y.max).toBe(95);
  });

  it('US scales the bounds to °F', async () => {
    renderPanels({ unitSystem: 'us', serverDefault: 'metric', preference: 'us' });
    await waitFor(() => {
      const y = coolantBounds();
      expect(y?.min).toBeCloseTo(140, 5);
    });
    const y = coolantBounds();
    expect(y.min).toBeCloseTo(140, 5);
    expect(y.max).toBeCloseTo(203, 5);
  });
});
