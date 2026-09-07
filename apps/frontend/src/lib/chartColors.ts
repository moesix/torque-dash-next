/**
 * Single source of truth for chart series colors (brand teal #009999).
 *
 * Previously the brand accent and the unit→color mapping were re-typed in
 * DiagnosticPanel, DiagnosticPanels, SessionSummaryCard and friends — a brand
 * change was a multi-file lockstep edit and the values had already drifted.
 * Rebranding is now: edit this file (+ public/brand/) and nothing else.
 */

export const BRAND_TEAL = '#009999';
export const SERIES_COLORS = [
  BRAND_TEAL,
  '#16a34a',
  '#dc2626',
  '#d97706',
  '#8b5cf6',
  '#f97316',
] as const;
/** Total Trim line colour (diagnostic computed series). */
export const SERIES_COLOR_TRIM = '#dc2626';
/** Teal reference-band fill (markArea default, dataZoom slider fill). */
export const BRAND_TEAL_AREA = 'rgba(0,153,153,0.15)';

export const UNIT_COLORS: Record<string, string> = {
  rpm: BRAND_TEAL,
  'km/h': '#f97316',
  V: '#16a34a',
  ':1': '#92400e',
  '°C': '#dc2626',
  psi: '#06b6d4',
};

export function colorForUnit(unit: string, fallbackIndex: number): string {
  return UNIT_COLORS[unit] ?? SERIES_COLORS[fallbackIndex % SERIES_COLORS.length];
}
