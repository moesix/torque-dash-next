// @vitest-environment jsdom
/**
 * Plan 045 — OverlayChart groups y-axes by the CONVERTED unit label.
 * Metric grouping must be unchanged (same count + names); US relabels axes
 * and converts series values.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { SeriesSource, TelemetryFrame, UserPreferences } from '@/lib/types';

const apiMocks = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, ...apiMocks };
});

const echartsMocks = vi.hoisted(() => {
  const setOption = vi.fn();
  return {
    setOption,
    init: vi.fn(() => ({
      setOption,
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    })),
  };
});

vi.mock('echarts/core', () => ({ init: echartsMocks.init, use: vi.fn() }));
vi.mock('echarts/charts', () => ({ LineChart: {} }));
vi.mock('echarts/components', () => ({
  GridComponent: {},
  TooltipComponent: {},
  MarkLineComponent: {},
  DataZoomComponent: {},
  DataZoomSliderComponent: {},
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));

import OverlayChart from '@/components/charts/OverlayChart';
import { UnitSystemProvider } from '@/app/unitSystem';
import { precomputeEpochs } from '@/lib/pidDecode';

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
    values: { kc: 1000, k5: 90 },
    engineRpm: 1000,
    vehicleSpeed: 100,
  },
  {
    timestamp: '2026-01-01T00:00:01.000Z',
    lon: null,
    lat: null,
    values: { kc: 1500, k5: 91 },
    engineRpm: 1500,
    vehicleSpeed: 110,
  },
];
const epochs = precomputeEpochs(frames);
const sources: SeriesSource[] = [
  { pid: 'vehicleSpeed', full: 'Vehicle Speed', short: 'Speed', unit: 'km/h', source: 'column', field: 'vehicleSpeed' },
  { pid: 'k5', full: 'Engine Coolant Temperature', short: 'Coolant', unit: '°C', source: 'pid' },
  { pid: 'kc', full: 'Engine RPM', short: 'Revs', unit: 'rpm', source: 'pid' },
];

function renderChart(prefs: UserPreferences) {
  apiMocks.getPreferences.mockResolvedValue(prefs);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UnitSystemProvider>
        <OverlayChart
          frames={frames}
          sources={sources}
          epochs={epochs}
          cursorTime={null}
          onCursorMove={() => {}}
        />
      </UnitSystemProvider>
    </QueryClientProvider> as ReactElement,
  );
}

/** Last full option (the cursor markLine effect issues a series-only merge). */
function lastOption() {
  const calls = echartsMocks.setOption.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0]?.yAxis) return calls[i][0];
  }
  return undefined;
}

describe('OverlayChart unit axes', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverShim);
    echartsMocks.setOption.mockClear();
  });

  it('metric retains the same axis count and names', async () => {
    renderChart({ unitSystem: 'metric', serverDefault: 'metric', preference: null });
    await waitFor(() => expect(echartsMocks.setOption).toHaveBeenCalled());
    const option = lastOption();
    expect(option.yAxis).toHaveLength(3);
    expect(option.yAxis.map((a: any) => a.name)).toEqual(['km/h', '°C', 'rpm']);
    const speedSeries = option.series.find((s: any) => s.name === 'Speed');
    expect(speedSeries.data[0][1]).toBe(100);
  });

  it('US relabels axes to mph/°F and converts values without changing the axis count', async () => {
    renderChart({ unitSystem: 'us', serverDefault: 'metric', preference: 'us' });
    await waitFor(() => {
      const names = lastOption()?.yAxis?.map((a: any) => a.name) ?? [];
      expect(names).toContain('mph');
    });
    const option = lastOption();
    expect(option.yAxis).toHaveLength(3);
    expect(option.yAxis.map((a: any) => a.name)).toEqual(['mph', '°F', 'rpm']);
    const speedSeries = option.series.find((s: any) => s.name === 'Speed');
    expect(speedSeries.data[0][1]).toBeCloseTo(62.137119, 5);
    const coolantSeries = option.series.find((s: any) => s.name === 'Coolant');
    expect(coolantSeries.data[0][1]).toBeCloseTo(194, 5);
  });
});
