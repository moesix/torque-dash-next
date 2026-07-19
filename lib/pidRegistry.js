/**
 * Unified PID registry — single source of truth for OBD-II PID metadata.
 *
 * Key format: Torque hex keys WITHOUT leading zeros (k5, kb, kc, kd, etc.)
 * Backend (llmPrompt.js) imports this directly.
 * Frontend (pidDecode.ts) maintains its own copy with the same keys.
 *
 * When adding new PIDs, update this file first, then sync pidDecode.ts.
 *
 * Source reconciliation:
 *   - Primary source: apps/frontend/src/lib/pidDecode.ts FALLBACK_MAP (25 entries)
 *   - Reconciles naming from both maps where keys overlap
 *   - All backend PID_NAME_MAP keys are a subset of the frontend map
 */
const PID_REGISTRY = {
  k10:      { fullName: 'MAF Air Flow Rate',           shortName: 'MAF',       unit: 'g/s' },
  k11:      { fullName: 'Throttle Position',           shortName: 'Throttle',  unit: '%' },
  k2f:      { fullName: 'Fuel Level Input',            shortName: 'Fuel',      unit: '%' },
  k33:      { fullName: 'Barometric Pressure',          shortName: 'Baro',      unit: 'kPa' },
  k45:      { fullName: 'Relative Throttle Position',  shortName: 'R Throttle',unit: '%' },
  k47:      { fullName: 'Absolute Throttle Pos B',     shortName: 'Throttle B',unit: '%' },
  k49:      { fullName: 'Accel Pedal Position D',      shortName: 'Pedal D',   unit: '%' },
  k4a:      { fullName: 'Accel Pedal Position E',      shortName: 'Pedal E',   unit: '%' },
  k5:       { fullName: 'Engine Coolant Temperature',  shortName: 'Coolant',   unit: '°C' },
  kb:       { fullName: 'Intake Manifold Pressure',    shortName: 'MAP',       unit: 'psi' },
  kc:       { fullName: 'Engine RPM',                  shortName: 'Revs',      unit: 'rpm' },
  kd:       { fullName: 'Vehicle Speed (OBD)',         shortName: 'Speed',     unit: 'km/h' },
  ke:       { fullName: 'Timing Advance',              shortName: 'Timing',    unit: '°' },
  kf:       { fullName: 'Intake Air Temperature',      shortName: 'IAT',       unit: '°C' },
  kff1001:  { fullName: 'MAF-derived Speed Est',       shortName: 'MAF Speed', unit: 'km/h' },
  kff1005:  { fullName: 'Fuel Trim (Long Term)',       shortName: 'LTFT',      unit: '%' },
  kff1006:  { fullName: 'Fuel Trim (Short Term)',      shortName: 'STFT',      unit: '%' },
  kff1007:  { fullName: 'GPS Bearing',                 shortName: 'Bearing',   unit: '°' },
  kff1201:  { fullName: 'Intake Air Temp',             shortName: 'IAT 2',     unit: '°C' },
  kff1214:  { fullName: 'O2 Sensor 1 Voltage',         shortName: 'O2S1V',     unit: 'V' },
  kff1223:  { fullName: 'Acceleration Sensor',          shortName: 'Accel',    unit: 'g' },
  kff1238:  { fullName: 'OBD Adapter Voltage',          shortName: 'Adapter V', unit: 'V' },
  kff124d:  { fullName: 'Commanded Air/Fuel Ratio',    shortName: 'AFR Cmd',   unit: ':1' },
  kff125a:  { fullName: 'Fuel Flow Rate',              shortName: 'Fuel Flow', unit: 'cc/min' },
  kff1278:  { fullName: 'Boost Pressure',              shortName: 'Boost',     unit: 'psi' },
};

module.exports = { PID_REGISTRY };
