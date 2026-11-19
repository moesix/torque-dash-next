'use strict';

/**
 * Unit-system presets + converters (backend).
 *
 * ⚠ CROSS-DIRECTORY REQUIRE: the factors/presets live in
 * `apps/frontend/src/lib/units.json` because the frontend Docker build context
 * is `./apps/frontend` — anything the SPA imports must live under that
 * directory. The backend builds from the repo root, so it can require the same
 * file here. Keep the JSON dependency-free and mirrored by
 * `apps/frontend/src/lib/units.ts`; both test suites assert its `version`.
 *
 * Display/export-time conversion ONLY. Stored telemetry stays canonical
 * (km/h, °C, kPa, L). Unknown units pass through untouched.
 */

const DATA = require('../apps/frontend/src/lib/units.json');

const FACTORS = DATA.factors;
const SYSTEMS = DATA.systems;

const VALID_SYSTEMS = ['metric', 'us', 'uk'];

/** Canonical label for every accepted alias (normalized source → canonical). */
const CANONICAL = {
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

const DEFAULT_DIGITS = {
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

function normalized(unit) {
  return String(unit == null ? '' : unit).trim().toLowerCase();
}

function kindOf(unit) {
  const c = CANONICAL[normalized(unit)];
  return c ? c.kind : 'none';
}

function canonicalUnit(unit) {
  const c = CANONICAL[normalized(unit)];
  return c ? c.unit : String(unit == null ? '' : unit).trim();
}

/** Round half away from zero to `digits` decimals. */
function roundTo(value, digits) {
  const f = 10 ** Math.max(0, digits);
  return (Math.sign(value) * Math.round(Math.abs(value) * f)) / f;
}

function toBase(kind, value, unit) {
  switch (kind) {
    case 'speed':
    case 'distance':
      return unit === 'mph' || unit === 'mi' ? value * FACTORS.kmPerMile : value;
    case 'temperature':
      return unit === '°F' ? (value - FACTORS.fahrenheitOffset) / FACTORS.fahrenheitScale : value;
    case 'pressure':
      if (unit === 'psi') return value / FACTORS.psiPerKpa;
      if (unit === 'bar') return value * 100;
      return value;
    case 'altitude':
      return unit === 'ft' ? value / FACTORS.feetPerMetre : value;
    case 'volume':
      if (unit === 'gal (US)') return value * FACTORS.litresPerUsGallon;
      if (unit === 'gal (UK)') return value * FACTORS.litresPerUkGallon;
      return value;
    case 'flow':
      if (unit === 'cc/min') return value * 0.06;
      if (unit === 'gal/h (US)') return value * FACTORS.litresPerUsGallon;
      return value;
    default:
      return value;
  }
}

function fromBase(kind, base, unit) {
  switch (kind) {
    case 'speed':
    case 'distance':
      return unit === 'mph' || unit === 'mi' ? base / FACTORS.kmPerMile : base;
    case 'temperature':
      return unit === '°F' ? base * FACTORS.fahrenheitScale + FACTORS.fahrenheitOffset : base;
    case 'pressure':
      if (unit === 'psi') return base * FACTORS.psiPerKpa;
      if (unit === 'bar') return base / 100;
      return base;
    case 'altitude':
      return unit === 'ft' ? base * FACTORS.feetPerMetre : base;
    case 'volume':
      if (unit === 'gal (US)') return base / FACTORS.litresPerUsGallon;
      if (unit === 'gal (UK)') return base / FACTORS.litresPerUkGallon;
      return base;
    case 'flow':
      if (unit === 'cc/min') return base / 0.06;
      if (unit === 'gal/h (US)') return base / FACTORS.litresPerUsGallon;
      return base;
    default:
      return base;
  }
}

function toLitresPer100(unit, value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === 'MPG (US)') return FACTORS.mpgUsNumerator / value;
  if (unit === 'MPG (UK)') return FACTORS.mpgUkNumerator / value;
  return value;
}

function fromLitresPer100(unit, l100) {
  if (!Number.isFinite(l100) || l100 <= 0) return null;
  if (unit === 'MPG (US)') return FACTORS.mpgUsNumerator / l100;
  if (unit === 'MPG (UK)') return FACTORS.mpgUkNumerator / l100;
  return l100;
}

function convert(value, from, system) {
  if (value == null || !Number.isFinite(value)) return value;
  const kind = kindOf(from);
  if (kind === 'none') return value;

  const source = canonicalUnit(from);
  const target = SYSTEMS[system] && SYSTEMS[system][kind];
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

function unitLabel(from, system) {
  const kind = kindOf(from);
  if (kind === 'none') return '';
  return (SYSTEMS[system] && SYSTEMS[system][kind]) || '';
}

function format(value, from, system, opts) {
  const kind = kindOf(from);
  const converted = convert(value, from, system);
  const unit = unitLabel(from, system) || String(from == null ? '' : from).trim();
  if (converted == null) return { text: '—', unit, value: null };
  const digits = opts && opts.digits != null ? opts.digits : DEFAULT_DIGITS[kind];
  const rounded = roundTo(converted, digits);
  return {
    text: unit ? `${rounded} ${unit}` : String(rounded),
    unit,
    value: rounded,
  };
}

function convertSeries(values, from, system) {
  return values.map(([ts, v]) => [ts, convert(v, from, system)]);
}

/**
 * Resolve the effective unit system for a request/user.
 * Precedence: explicit user value → deploy default (DEFAULT_UNIT_SYSTEM) → metric.
 * Pass the validated `config.units.defaultSystem`; never ad-hoc `|| 'metric'`.
 */
function resolveUnitSystem(userUnitSystem, serverDefault) {
  // Normalize BOTH inputs: config trims/lowercases DEFAULT_UNIT_SYSTEM, but
  // callers that pass the raw env value (or a defensive uppercase user value)
  // must resolve identically. The API still validates stored values.
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  if (VALID_SYSTEMS.includes(norm(userUnitSystem))) return norm(userUnitSystem);
  if (VALID_SYSTEMS.includes(norm(serverDefault))) return norm(serverDefault);
  return 'metric';
}

/** Human/machine names used in the AI prompt and the preferences API. */
const SYSTEM_NAMES = {
  metric: 'Metric',
  us: 'US customary',
  uk: 'UK',
};

const SYSTEM_DESCRIPTIONS = {
  metric: 'Metric (km/h, °C, kPa, L, L/100km)',
  us: 'US customary (mph, °F, psi, US gal, MPG US)',
  uk: 'UK (mph, °C, psi, MPG UK)',
};

module.exports = {
  UNITS_VERSION: DATA.version,
  UNIT_FACTORS: FACTORS,
  UNIT_SYSTEMS: SYSTEMS,
  VALID_SYSTEMS,
  SYSTEM_NAMES,
  SYSTEM_DESCRIPTIONS,
  kindOf,
  convert,
  unitLabel,
  format,
  convertSeries,
  roundTo,
  resolveUnitSystem,
};
