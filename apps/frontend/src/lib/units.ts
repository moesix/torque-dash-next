/**
 * Unit-system presets + converters (frontend).
 *
 * The factors and preset labels live in `units.json` so the backend
 * (`lib/units.js`) can consume the exact same data — a factor edit cannot
 * land on one runtime only. Display-time conversion ONLY: stored telemetry
 * stays canonical (km/h, °C, kPa, L).
 *
 * Unknown units (rpm, %, V, g, :1, bare °, g/s, …) are returned unchanged.
 * Bare `°` is NEVER temperature — only °C/°F (and C/F) are.
 */
import unitsData from './units.json';
import type { UnitSystem } from './types';

export type { UnitSystem };
export type UnitKind =
  | 'speed'
  | 'distance'
  | 'temperature'
  | 'pressure'
  | 'altitude'
  | 'volume'
  | 'economy'
  | 'flow'
  | 'none';

interface UnitsData {
  version: number;
  factors: {
    kmPerMile: number;
    fahrenheitOffset: number;
    fahrenheitScale: number;
    psiPerKpa: number;
    feetPerMetre: number;
    litresPerUsGallon: number;
    litresPerUkGallon: number;
    mpgUsNumerator: number;
    mpgUkNumerator: number;
  };
  systems: Record<UnitSystem, Record<Exclude<UnitKind, 'none'>, string>>;
}

const DATA = unitsData as UnitsData;

/** Version of the shared JSON — asserted by both test suites. */
export const UNITS_VERSION = DATA.version;
export const UNIT_FACTORS = DATA.factors;
export const UNIT_SYSTEMS = DATA.systems;

/** Canonical label for every accepted alias (normalized source → canonical). */
const CANONICAL: Record<string, { kind: UnitKind; unit: string }> = {
  // speed
  'km/h': { kind: 'speed', unit: 'km/h' },
  kph: { kind: 'speed', unit: 'km/h' },
  kmh: { kind: 'speed', unit: 'km/h' },
  mph: { kind: 'speed', unit: 'mph' },
  // distance
  km: { kind: 'distance', unit: 'km' },
  mi: { kind: 'distance', unit: 'mi' },
  // temperature
  '°c': { kind: 'temperature', unit: '°C' },
  c: { kind: 'temperature', unit: '°C' },
  celsius: { kind: 'temperature', unit: '°C' },
  '°f': { kind: 'temperature', unit: '°F' },
  f: { kind: 'temperature', unit: '°F' },
  fahrenheit: { kind: 'temperature', unit: '°F' },
  // pressure
  kpa: { kind: 'pressure', unit: 'kPa' },
  bar: { kind: 'pressure', unit: 'bar' },
  psi: { kind: 'pressure', unit: 'psi' },
  // altitude / length
  m: { kind: 'altitude', unit: 'm' },
  mtr: { kind: 'altitude', unit: 'm' },
  metre: { kind: 'altitude', unit: 'm' },
  meter: { kind: 'altitude', unit: 'm' },
  ft: { kind: 'altitude', unit: 'ft' },
  feet: { kind: 'altitude', unit: 'ft' },
  foot: { kind: 'altitude', unit: 'ft' },
  // volume
  l: { kind: 'volume', unit: 'L' },
  liter: { kind: 'volume', unit: 'L' },
  litre: { kind: 'volume', unit: 'L' },
  gal: { kind: 'volume', unit: 'gal (US)' },
  'gal (us)': { kind: 'volume', unit: 'gal (US)' },
  gallon: { kind: 'volume', unit: 'gal (US)' },
  gallons: { kind: 'volume', unit: 'gal (US)' },
  'gal (uk)': { kind: 'volume', unit: 'gal (UK)' },
  'gal (imp)': { kind: 'volume', unit: 'gal (UK)' },
  'imperial gallon': { kind: 'volume', unit: 'gal (UK)' },
  // economy
  'l/100km': { kind: 'economy', unit: 'L/100km' },
  'l/100 km': { kind: 'economy', unit: 'L/100km' },
  mpg: { kind: 'economy', unit: 'MPG (US)' },
  'mpg (us)': { kind: 'economy', unit: 'MPG (US)' },
  'mpg (uk)': { kind: 'economy', unit: 'MPG (UK)' },
  'mpg (imp)': { kind: 'economy', unit: 'MPG (UK)' },
  // flow
  'cc/min': { kind: 'flow', unit: 'cc/min' },
  'l/h': { kind: 'flow', unit: 'L/h' },
  'gal/h (us)': { kind: 'flow', unit: 'gal/h (US)' },
};

function normalized(unit: string | null | undefined): string {
  return String(unit ?? '').trim().toLowerCase();
}

export function kindOf(unit: string): UnitKind {
  return CANONICAL[normalized(unit)]?.kind ?? 'none';
}

function canonicalUnit(unit: string): string {
  return CANONICAL[normalized(unit)]?.unit ?? String(unit ?? '').trim();
}

const DEFAULT_DIGITS: Record<UnitKind, number> = {
  speed: 0,
  distance: 1,
  temperature: 0,
  pressure: 0,
  altitude: 0,
  volume: 2,
  economy: 1,
  flow: 1,
  none: 1,
};

/** Round half away from zero to `digits` decimals. */
export function roundTo(value: number, digits: number): number {
  const f = 10 ** Math.max(0, digits);
  return (Math.sign(value) * Math.round(Math.abs(value) * f)) / f;
}

function toBase(kind: UnitKind, value: number, unit: string): number | null {
  const f = DATA.factors;
  switch (kind) {
    case 'speed':
    case 'distance':
      return unit === 'mph' || unit === 'mi' ? value * f.kmPerMile : value;
    case 'temperature':
      return unit === '°F' ? (value - f.fahrenheitOffset) / f.fahrenheitScale : value;
    case 'pressure':
      if (unit === 'psi') return value / f.psiPerKpa;
      if (unit === 'bar') return value * 100;
      return value;
    case 'altitude':
      return unit === 'ft' ? value / f.feetPerMetre : value;
    case 'volume':
      if (unit === 'gal (US)') return value * f.litresPerUsGallon;
      if (unit === 'gal (UK)') return value * f.litresPerUkGallon;
      return value;
    case 'flow': {
      // Base: L/h.
      if (unit === 'cc/min') return value * 0.06;
      if (unit === 'gal/h (US)') return value * f.litresPerUsGallon;
      return value; // L/h
    }
    default:
      return value;
  }
}

function fromBase(kind: UnitKind, base: number, unit: string): number {
  const f = DATA.factors;
  switch (kind) {
    case 'speed':
    case 'distance':
      return unit === 'mph' || unit === 'mi' ? base / f.kmPerMile : base;
    case 'temperature':
      return unit === '°F' ? base * f.fahrenheitScale + f.fahrenheitOffset : base;
    case 'pressure':
      if (unit === 'psi') return base * f.psiPerKpa;
      if (unit === 'bar') return base / 100;
      return base;
    case 'altitude':
      return unit === 'ft' ? base * f.feetPerMetre : base;
    case 'volume':
      if (unit === 'gal (US)') return base / f.litresPerUsGallon;
      if (unit === 'gal (UK)') return base / f.litresPerUkGallon;
      return base;
    case 'flow':
      if (unit === 'cc/min') return base / 0.06;
      if (unit === 'gal/h (US)') return base / f.litresPerUsGallon;
      return base;
    default:
      return base;
  }
}

/** L/100km → MPG numerator pivot. Both MPG families are supported. */
function toLitresPer100(unit: string, value: number): number | null {
  const f = DATA.factors;
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === 'MPG (US)') return f.mpgUsNumerator / value;
  if (unit === 'MPG (UK)') return f.mpgUkNumerator / value;
  return value;
}

function fromLitresPer100(unit: string, l100: number): number | null {
  const f = DATA.factors;
  if (!Number.isFinite(l100) || l100 <= 0) return null;
  if (unit === 'MPG (US)') return f.mpgUsNumerator / l100;
  if (unit === 'MPG (UK)') return f.mpgUkNumerator / l100;
  return l100;
}

/**
 * Convert `value` from `from` into `system`. Unknown units and already-target
 * units are returned unchanged (idempotent). Economy from a zero/negative
 * value yields null (undefined MPG).
 */
export function convert(
  value: number | null,
  from: string,
  system: UnitSystem,
): number | null {
  if (value == null || !Number.isFinite(value)) return value;
  const kind = kindOf(from);
  if (kind === 'none') return value;

  const source = canonicalUnit(from);
  const target = DATA.systems[system]?.[kind];
  if (!target || target === source) return value;

  if (kind === 'economy') {
    const l100 = toLitresPer100(source, value);
    if (l100 == null) return null;
    return fromLitresPer100(target, l100);
  }

  const base = toBase(kind, value, source);
  if (base == null) return null;
  return fromBase(kind, base, target);
}

/** Target unit label for a convertible unit, or '' when nothing is known. */
export function unitLabel(from: string, system: UnitSystem): string {
  const kind = kindOf(from);
  if (kind === 'none') return '';
  return DATA.systems[system]?.[kind] ?? '';
}

export interface FormattedValue {
  text: string;
  unit: string;
  value: number | null;
}

/**
 * Convert + format a single value. `text` includes the unit (or '—' when the
 * value is missing). `unit` falls back to the original string for units that
 * do not convert (rpm, %, …) so callers can render it verbatim.
 */
export function format(
  value: number | null,
  from: string,
  system: UnitSystem,
  opts?: { digits?: number },
): FormattedValue {
  const kind = kindOf(from);
  const converted = convert(value, from, system);
  const unit = unitLabel(from, system) || String(from ?? '').trim();
  if (converted == null) return { text: '—', unit, value: null };
  const digits = opts?.digits ?? DEFAULT_DIGITS[kind];
  const rounded = roundTo(converted, digits);
  const num = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return {
    text: unit ? `${num} ${unit}` : num,
    unit,
    value: rounded,
  };
}

export function convertSeries(
  values: Array<[number, number | null]>,
  from: string,
  system: UnitSystem,
): Array<[number, number | null]> {
  return values.map(([ts, v]) => [ts, convert(v, from, system)]);
}
