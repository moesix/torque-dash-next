/**
 * Series selection panel — lets the user pick which telemetry metrics to plot.
 *
 * Features:
 * - Search filtering by name / key
 * - Category grouping with expand/collapse
 * - Color swatches matching the overlay chart palette
 * - Select All / Clear / Reset buttons
 * - Selection count badge
 */

import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { SeriesSource } from '@/lib/types';

// ── Color palette (must match OverlayChart) ──────────────────────────────

const COLORS = [
  '#009999',
  '#16a34a',
  '#dc2626',
  '#d97706',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#06b6d4',
  '#84cc16',
];

// ── Category heuristic ───────────────────────────────────────────────────

function categorize(src: SeriesSource): string {
  const text = `${src.full} ${src.short}`.toLowerCase();
  if (
    /coolant|temperature|iat/.test(text) ||
    src.unit === '°C' ||
    src.unit === '°F'
  ) {
    return 'Temperature';
  }
  if (
    /voltage|o2|adapter|battery|current/.test(text) ||
    src.unit === 'V'
  ) {
    return 'Electrical';
  }
  if (
    /fuel|afr|throttle|pedal|boost|maf|air.*flow|fuel.*trim|injector/.test(text) ||
    src.unit === '%' ||
    src.unit === 'psi' ||
    src.unit === 'g/s' ||
    src.unit === 'cc/min' ||
    src.unit === ':1'
  ) {
    return 'Fuel';
  }
  if (
    /rpm|speed|km\/h|drivetrain|gear|odometer/.test(text) ||
    src.unit === 'km/h' ||
    src.unit === 'rpm'
  ) {
    return 'Drivetrain';
  }
  if (/engine|manifold|timing|barometric|baro|map/.test(text)) {
    return 'Engine';
  }
  return 'Other';
}

const CATEGORY_LABELS: Record<string, string> = {
  Temperature: 'Temperature',
  Electrical: 'Electrical',
  Fuel: 'Fuel & Air',
  Drivetrain: 'Drivetrain',
  Engine: 'Engine',
  Other: 'Other',
};

const CATEGORY_ORDER = [
  'Engine',
  'Fuel',
  'Temperature',
  'Electrical',
  'Drivetrain',
  'Other',
];

// ── Props ────────────────────────────────────────────────────────────────

interface Props {
  available: SeriesSource[];
  selected: string[];
  onToggle: (pid: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onReset: () => void;
}

// ── Component ────────────────────────────────────────────────────────────

export default function PidTogglePanel({
  available,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  onReset,
}: Props) {
  const [search, setSearch] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    () => new Set(['Engine']),
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return available;
    const q = search.toLowerCase();
    return available.filter(
      (s) =>
        s.full.toLowerCase().includes(q) ||
        s.short.toLowerCase().includes(q) ||
        s.pid.toLowerCase().includes(q),
    );
  }, [available, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, SeriesSource[]>();
    for (const src of filtered) {
      const cat = categorize(src);
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(src);
    }
    return map;
  }, [filtered]);

  // Assign color index by position in ALL available (stable mapping)
  const colorIndex = useMemo(() => {
    const map = new Map<string, number>();
    available.forEach((s, i) => map.set(s.pid, i));
    return map;
  }, [available]);

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const onSearchChange = (e: ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
  };

  const count = selected.length;
  const total = available.length;

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onSelectAll}
          className="rounded bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700 hover:bg-teal-100 dark:bg-teal-900/40 dark:text-teal-300 dark:hover:bg-teal-900/60"
        >
          Select All
        </button>
        <button
          type="button"
          onClick={onClear}
          className="rounded bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:bg-[var(--bg-surface)] dark:text-[var(--text-secondary)] dark:hover:bg-[var(--bg-elevated)]"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onReset}
          className="rounded bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:bg-[var(--bg-surface)] dark:text-[var(--text-secondary)] dark:hover:bg-[var(--bg-elevated)]"
        >
          Reset
        </button>
        <span className="ml-auto text-xs text-gray-400 dark:text-[var(--text-muted)]">
          {count} of {total} selected
        </span>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={onSearchChange}
        placeholder="Search metrics…"
        className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm placeholder-gray-400 focus:border-teal-400 focus:outline-none dark:border-[var(--border-default)] dark:bg-[var(--bg-surface)] dark:text-[var(--text-primary)] dark:placeholder-[var(--text-muted)]"
        aria-label="Filter metrics"
      />

      {/* Category list */}
      <div className="max-h-[420px] space-y-1 overflow-y-auto">
        {CATEGORY_ORDER.map((cat) => {
          const items = grouped.get(cat);
          if (!items || items.length === 0) return null;
          const isExpanded = expandedCategories.has(cat);

          return (
            <div key={cat}>
              {/* Category header */}
              <button
                type="button"
                onClick={() => toggleCategory(cat)}
                aria-expanded={isExpanded}
                aria-controls={`pid-category-${cat}`}
                className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs font-semibold text-gray-500 hover:bg-gray-50 dark:text-[var(--text-muted)] dark:hover:bg-[var(--bg-surface)]"
              >
                <span className="w-3 text-center text-[10px]">
                  {isExpanded ? '▼' : '▶'}
                </span>
                <span>{CATEGORY_LABELS[cat] ?? cat}</span>
                <span className="ml-auto text-[10px] text-gray-400 dark:text-[var(--text-muted)]">
                  {items.length}
                </span>
              </button>

              {/* Items */}
              {isExpanded && (
                <div id={`pid-category-${cat}`} className="ml-2 space-y-0.5">
                  {items.map((src) => {
                    const idx = colorIndex.get(src.pid) ?? 0;
                    const color = COLORS[idx % COLORS.length];
                    const isChecked = selected.includes(src.pid);

                    return (
                      <label
                        key={src.pid}
                        className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-gray-50 dark:text-[var(--text-primary)] dark:hover:bg-[var(--bg-surface)]"
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => onToggle(src.pid)}
                          className="h-3 w-3"
                        />
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="truncate flex-1">{src.short}</span>
                        <span className="text-[10px] text-gray-400 shrink-0 dark:text-[var(--text-muted)]">
                          {src.unit}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <p className="py-4 text-center text-xs text-gray-400 dark:text-[var(--text-muted)]">
            No metrics match your search.
          </p>
        )}
      </div>
    </div>
  );
}
