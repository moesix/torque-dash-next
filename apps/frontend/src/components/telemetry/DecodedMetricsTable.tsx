/**
 * "What was uploaded" table — shows all decoded PIDs with their stats.
 *
 * Uses pre-computed memoized series data (no re-scan of frames).
 * Collapsible to keep the dashboard compact.
 */

import { useMemo, useState } from 'react';
import { Card, Title } from '@tremor/react';
import type { SeriesSource } from '@/lib/types';
import { computeStats } from '@/lib/pidDecode';

// ── Props ────────────────────────────────────────────────────────────────

interface Props {
  /** All available sources (columns + PIDs). */
  sources: SeriesSource[];
  /** Pre-computed time-series data keyed by pid (NOT re-scanned). */
  seriesData: Map<string, [number, number | null][]>;
}

// ── Format helpers ───────────────────────────────────────────────────────

function fmtNum(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(1);
}

// ── Component ────────────────────────────────────────────────────────────

export default function DecodedMetricsTable({ sources, seriesData }: Props) {
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => {
    return sources.map((src) => {
      const data = seriesData.get(src.pid);
      const stats = data ? computeStats(data) : null;
      return { src, stats };
    });
  }, [sources, seriesData]);

  const summary = `${sources.length} metrics decoded`;

  // Separate column sources from pid sources for display clarity
  const columnRows = rows.filter((r) => r.src.source === 'column');
  const pidRows = rows.filter((r) => r.src.source === 'pid');

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between"
        aria-expanded={expanded}
        aria-controls="decoded-table-body"
      >
        <Title>Decoded Metrics</Title>
        <span className="flex items-center gap-2 text-sm text-gray-400 dark:text-[var(--text-muted)]">
          <span className="text-xs">{summary}</span>
          <span className="text-xs">{expanded ? '▲' : '▼'}</span>
        </span>
      </button>

      {expanded && (
        <div id="decoded-table-body" className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-gray-500 dark:border-[var(--border-default)] dark:text-[var(--text-muted)]">
                <th className="pb-1 pr-2 font-medium">Name</th>
                <th className="pb-1 pr-2 font-mono font-medium">PID</th>
                <th className="pb-1 pr-2 font-medium">Unit</th>
                <th className="pb-1 pr-2 text-right font-medium">Min</th>
                <th className="pb-1 pr-2 text-right font-medium">Max</th>
                <th className="pb-1 pr-2 text-right font-medium">Avg</th>
                <th className="pb-1 text-right font-medium">Last</th>
              </tr>
            </thead>
            <tbody>
              {/* Column sources */}
              {columnRows.map(({ src, stats }) => (
                <tr
                  key={src.pid}
                  className="border-b border-gray-100 text-gray-700 dark:border-[var(--border-default)] dark:text-[var(--text-primary)]"
                >
                  <td className="py-1 pr-2 font-medium">{src.short}</td>
                  <td className="py-1 pr-2 font-mono text-gray-400 dark:text-[var(--text-muted)]">
                    {src.pid}
                  </td>
                  <td className="py-1 pr-2 text-gray-400 dark:text-[var(--text-muted)]">{src.unit}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtNum(stats.min) : '—'}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtNum(stats.max) : '—'}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtNum(stats.avg) : '—'}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {stats?.last != null ? fmtNum(stats.last) : '—'}
                  </td>
                </tr>
              ))}

              {/* Visual separator */}
              {pidRows.length > 0 && columnRows.length > 0 && (
                <tr className="text-[10px] text-gray-300 dark:text-[var(--text-muted)]">
                  <td colSpan={7} className="py-1 italic">
                    — OBD-II PIDs —
                  </td>
                </tr>
              )}

              {/* PID sources */}
              {pidRows.map(({ src, stats }) => (
                <tr
                  key={src.pid}
                  className="border-b border-gray-100 text-gray-700 dark:border-[var(--border-default)] dark:text-[var(--text-primary)]"
                >
                  <td className="py-1 pr-2 font-medium">{src.short}</td>
                  <td className="py-1 pr-2 font-mono text-gray-400 dark:text-[var(--text-muted)]">
                    {src.pid}
                  </td>
                  <td className="py-1 pr-2 text-gray-400 dark:text-[var(--text-muted)]">{src.unit}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtNum(stats.min) : '—'}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtNum(stats.max) : '—'}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtNum(stats.avg) : '—'}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {stats?.last != null ? fmtNum(stats.last) : '—'}
                  </td>
                </tr>
              ))}

              {pidRows.length === 0 && columnRows.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-gray-400 dark:text-[var(--text-muted)]">
                    No telemetry frames available.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
