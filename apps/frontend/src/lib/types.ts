/**
 * Domain types for the TorqueDash frontend.
 *
 * NOTE on casing: the Express/Sequelize backend returns telemetry rows with
 * snake_case DB columns `engine_rpm` / `vehicle_speed` (no `underscored:true`,
 * so the JSON keys match the column names). `lib/api.ts` normalizes those rows
 * into the camelCase `TelemetryFrame` shape used throughout the UI.
 *
 * Sessions are returned as a LIGHTWEIGHT summary (H2 scaled-down contract):
 * `GET /api/sessions` and `GET /api/sessions/:id` no longer include the full
 * `Logs` array. Instead each session carries pre-computed summary fields
 * (`startDate`, `endDate`, `duration`, `maxSpeed`, `maxRpm`). Paged telemetry
 * frames are still fetched separately via `GET /api/sessions/:id/telemetry`.
 */

/** Normalized telemetry frame as consumed by the UI. */
export interface TelemetryFrame {
  timestamp: string;
  lon: number | null;
  lat: number | null;
  values: Record<string, unknown>;
  engineRpm: number | null;
  vehicleSpeed: number | null;
}

/** Raw row as returned by `GET /api/sessions/:id/telemetry`. */
export interface RawTelemetryRow {
  timestamp: string;
  lon: number | null;
  lat: number | null;
  values: Record<string, unknown>;
  engine_rpm: number | null;
  vehicle_speed: number | null;
}

export interface Session {
  id: string;
  /** Short id used by copy/join (distinct from the PK `id`). */
  sessionId?: string;
  name: string | null;
  userId: number;
  startLocation?: string | null;
  endLocation?: string | null;
  /** Populated by the backend's aggregateSummaries() query. */
  startDate?: string;
  endDate?: string;
  /** Duration as a compact human-readable string (e.g. "1h 02m 05s"). */
  duration?: string | null;
  /** Pre-computed summary: peak vehicle speed in km/h (from `vehicle_speed`). */
  maxSpeed?: number | null;
  /** Pre-computed summary: peak engine RPM (from `engine_rpm`). */
  maxRpm?: number | null;
}

/** Global site settings, read via GET /api/settings. */
export interface Settings {
  /** When true, public registration is closed. */
  disableRegistration: boolean;
}
