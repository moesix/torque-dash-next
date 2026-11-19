/**
 * "What was uploaded" table — shows all decoded PIDs with their stats.
 *
 * Receives pre-computed stats (folded in one pass, no tuple arrays).
 */

import { useMemo } from 'react';
import type { SeriesSource } from '@/lib/types';
import type { SeriesStats } from '@/lib/pidDecode';
import { useUnits } from '@/app/unitSystem';
import { convert, unitLabel } from '@/lib/units';

// ── Props ────────────────────────────────────────────────────────────────

interface Props {
  /** All available sources (columns + PIDs). */
  sources: SeriesSource[];
  /** Pre-computed aggregate stats keyed by pid (NOT re-scanned). */
  stats: Map<string, SeriesStats | null>;
}

// ── Format helpers ───────────────────────────────────────────────────────

function fmtNum(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toFixed(1);
}

// ── Component ────────────────────────────────────────────────────────────

export default function DecodedMetricsTable({ sources, stats }: Props) {
  const { system } = useUnits();
  const rows = useMemo(() => {
    return sources.map((src) => ({
      src,
      stats: stats.get(src.pid) ?? null,
    }));
  }, [sources, stats]);

  const summary = `${sources.length} metrics decoded`;

  /** Convert the stat into the current display system, then apply the table's
   *  existing numeric formatting (precision stays as today). */
  const fmtStat = (src: SeriesSource, v: number) => fmtNum(convert(v, src.unit, system) ?? v);

  // Separate column sources from pid sources for display clarity
  const columnRows = rows.filter((r) => r.src.source === 'column');
  const pidRows = rows.filter((r) => r.src.source === 'pid');

  return (
    <div className="overflow-hidden card">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold leading-relaxed">Decoded Metrics</h3>
        <span className="text-xs text-gray-400 dark:text-[var(--text-muted)]">
          {summary}
        </span>
      </div>

      <div className="overflow-x-auto">
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
                  <td className="py-1 pr-2 text-gray-400 dark:text-[var(--text-muted)]">{unitLabel(src.unit, system) || src.unit}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtStat(src, stats.min) : '—'}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtStat(src, stats.max) : '—'}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtStat(src, stats.avg) : '—'}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {stats?.last != null ? fmtStat(src, stats.last) : '—'}
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
                  <td className="py-1 pr-2 text-gray-400 dark:text-[var(--text-muted)]">{unitLabel(src.unit, system) || src.unit}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtStat(src, stats.min) : '—'}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtStat(src, stats.max) : '—'}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {stats ? fmtStat(src, stats.avg) : '—'}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {stats?.last != null ? fmtStat(src, stats.last) : '—'}
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
    </div>
  );
}
