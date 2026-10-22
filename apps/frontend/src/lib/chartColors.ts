/**
 * Single source of truth for chart colors + theme-aware chart neutrals.
 *
 * Canvas-rendered charts (ECharts) cannot resolve CSS custom properties, so
 * the accent hex lives here and must stay in sync with `--accent` in
 * index.css. Rebranding is now: edit this file (+ index.css `--accent`,
 * + public/brand/) and nothing else.
 *
 * Theme neutrals (axis labels, split lines, tooltips) are read from the
 * live theme: `getChartTheme()` returns the palette for the current `<html>`
 * class state, and callers hold it in a local `useState` re-seeded by
 * `subscribeChartTheme()` (a MutationObserver on `<html>`'s class attr) so
 * charts re-apply the neutrals on theme change without a full refetch.
 */

/** Brand accent, canvas-safe (sync with `--accent` in index.css). */
export const ACCENT = '#14b8a6';
/** Reference-band fill / dataZoom filler (accent at 15%). */
export const ACCENT_AREA = 'rgba(20,184,166,0.15)';
/** Subtler accent wash (dataZoom slider track, 8%). */
export const ACCENT_AREA_SOFT = 'rgba(20,184,166,0.08)';

/**
 * Series palette for multi-series overlays — one teal only (the accent's
 * near-twin #14b8a6 is reserved for the UI accent, so series[0] is shifted
 * to teal-600). 10 entries so dense overlays stay distinguishable on dark
 * surfaces; PidTogglePanel shares this array for its color swatches.
 */
export const SERIES_COLORS = [
  '#0d9488', // teal-600
  '#16a34a', // green-600
  '#dc2626', // red-600
  '#d97706', // amber-600
  '#8b5cf6', // violet-500
  '#f97316', // orange-500
  '#ec4899', // pink-500
  '#eab308', // yellow-500
  '#06b6d4', // cyan-500
  '#84cc16', // lime-500
] as const;

/** Total Trim line colour (diagnostic computed series). */
export const SERIES_COLOR_TRIM = '#dc2626';

export const UNIT_COLORS: Record<string, string> = {
  rpm: SERIES_COLORS[0],
  'km/h': '#f97316',
  V: '#16a34a',
  ':1': '#92400e',
  '°C': '#dc2626',
  psi: '#06b6d4',
};

/**
 * Canonical per-metric colors for dashboards/aggregates, so the same metric
 * never disagrees across cards (SessionSummaryCard gauges vs UNIT_COLORS).
 */
export const METRIC_COLORS = {
  rpm: UNIT_COLORS.rpm,
  speed: UNIT_COLORS['km/h'],
  coolant: UNIT_COLORS['°C'],
  temperature: UNIT_COLORS['°C'],
} as const;

export function colorForUnit(unit: string, fallbackIndex: number): string {
  return UNIT_COLORS[unit] ?? SERIES_COLORS[fallbackIndex % SERIES_COLORS.length];
}

// ── Theme-aware chart neutrals ───────────────────────────────────────────

export interface ChartThemeColors {
  /** Axis + dataZoom-slider label text. */
  axisLabel: string;
  /** Grid / split lines and neutral reference (mark) lines. */
  splitLine: string;
  /** Tooltip body text. */
  tooltipText: string;
  /** Tooltip background. */
  tooltipBg: string;
  /** Tooltip border. */
  tooltipBorder: string;
}

const CHART_THEME_DARK: ChartThemeColors = {
  axisLabel: '#a1a1aa',
  splitLine: '#2d3039',
  tooltipText: '#e4e4e7',
  tooltipBg: '#1a1d27',
  tooltipBorder: '#3f4250',
};

const CHART_THEME_LIGHT: ChartThemeColors = {
  axisLabel: '#52525b',
  splitLine: '#e4e4e7',
  tooltipText: '#18181b',
  tooltipBg: '#ffffff',
  tooltipBorder: '#e4e4e7',
};

/** Chart neutrals for the theme currently applied to `<html>`. */
export function getChartTheme(): ChartThemeColors {
  return document.documentElement.classList.contains('dark')
    ? CHART_THEME_DARK
    : CHART_THEME_LIGHT;
}

/**
 * Subscribe to theme switches (the `.dark` class on `<html>` toggled by
 * lib/theme.ts). Returns a monotonically increasing version the caller adds
 * to its effect deps to re-apply chart neutrals.
 */
export function subscribeChartTheme(onChange: () => void): () => void {
  const mo = new MutationObserver(() => onChange());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => mo.disconnect();
}
