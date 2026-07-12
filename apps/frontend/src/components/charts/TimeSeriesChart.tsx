import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { usePlaybackStore } from '@/app/playbackStore';
import type { TelemetryFrame } from '@/lib/types';

// Tree-shaken ECharts build.
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

// All chart instances join this group so their axis pointers stay in sync when
// the user hovers any one of them.
const GROUP = 'torqueGroup';

type Metric = 'engineRpm' | 'vehicleSpeed';

interface Props {
  frames: TelemetryFrame[];
  metric: Metric;
  title: string;
  color?: string;
}

export default function TimeSeriesChart({ frames, metric, title, color }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const setCursorTime = usePlaybackStore((s) => s.setCursorTime);
  const cursorTime = usePlaybackStore((s) => s.cursorTime);

  // Init once: create instance, join the shared group, forward axis-pointer
  // moves into the playback store.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current);
    chartRef.current = chart;
    chart.group = GROUP;
    echarts.connect(GROUP);

    chart.on('updateAxisPointer', (params: any) => {
      const axisValue = params?.axesInfo?.[0]?.axisValue;
      if (typeof axisValue === 'number') {
        setCursorTime(axisValue);
      }
    });

    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, [setCursorTime]);

  // (Re)build series when data or metric changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const data = frames.map(
      (f) =>
        [new Date(f.timestamp).getTime(), f[metric] ?? null] as [
          number,
          number | null,
        ],
    );
    chart.setOption(
      {
        animation: false,
        grid: { left: 52, right: 16, top: 24, bottom: 28 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'time' },
        yAxis: { type: 'value', name: title },
        series: [
          {
            type: 'line',
            showSymbol: false,
            smooth: false,
            data,
            lineStyle: color ? { color, width: 2 } : undefined,
            itemStyle: color ? { color } : undefined,
            markLine: {
              symbol: 'none',
              silent: true,
              data: [{ xAxis: cursorTime ?? 0 }],
              lineStyle: { color: '#f43f5e', type: 'solid', width: 1.5 },
              label: { show: false },
            },
          },
        ],
      },
      { notMerge: true },
    );
  }, [frames, metric, title, color, cursorTime]);

  return <div ref={containerRef} style={{ width: '100%', height: 280 }} />;
}
