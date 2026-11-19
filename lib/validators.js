'use strict';

const Joi = require('joi');

// ── Joi schemas for controller input validation ────────────────────────────

const renameSchema = Joi.object({
  name: Joi.string().trim().min(1).max(255).required(),
});

const notesSchema = Joi.object({
  notes: Joi.string().allow(null, '').max(10000).required(),
});

const cutSchema = Joi.object({
  from: Joi.date().iso().required(),
  to: Joi.date().iso().required(),
}).custom((obj, helpers) => {
  if (obj.from > obj.to) {
    return helpers.error('any.invalid', { message: 'from must be before or equal to to' });
  }
  return obj;
}, 'from <= to validation');

const filterSchema = Joi.object({
  filterNumber: Joi.number().integer().min(2).max(100000).required(),
});

// Sessions.name / startLocation / endLocation are VARCHAR(255) (baseline
// 000/013). Without the cap a longer value reaches Postgres as 22001 and the
// generic handler turns it into a 500 after drainIngest(); gate it here so the
// write is a 400 at the route. 255 stays accepted — the cap matches the column.
const copySchema = Joi.object({
  name: Joi.string().trim().min(1).max(255).required(),
});

const joinSchema = Joi.object({
  joinSessionId: Joi.number().integer().positive().required(),
  name: Joi.string().trim().min(1).max(255).required(),
});

const addLocationSchema = Joi.object({
  locations: Joi.object({
    start: Joi.string().max(255).required(),
    end: Joi.string().max(255).required(),
  }).required(),
});

const vehicleCreateSchema = Joi.object({
  name: Joi.string().min(1).max(255).required(),
  make: Joi.string().allow(null, '').optional(),
  model: Joi.string().allow(null, '').optional(),
  year: Joi.number().integer().min(1900).max(2099).allow(null).optional(),
  // The SPA always sends engineCc (null when the field is blank) — see
  // apps/frontend/src/features/settings/VehicleManager.tsx. Without allow(null)
  // every create with an empty displacement would 400.
  engineCc: Joi.number().integer().min(50).allow(null).optional(),
});

const vehicleUpdateSchema = Joi.object({
  name: Joi.string().min(1).max(255).optional(),
  make: Joi.string().allow(null, '').optional(),
  model: Joi.string().allow(null, '').optional(),
  year: Joi.number().integer().min(1900).max(2099).allow(null).optional(),
  engineCc: Joi.number().integer().min(50).allow(null).optional(),
}).min(1);

const telemetryRangeSchema = Joi.object({
  from: Joi.date().iso().required(),
  to: Joi.date().iso().required(),
  limit: Joi.number().integer().min(1).max(10000).default(5000),
});

// ── Path-parameter validation ──────────────────────────────────────────────

// Database ids are positive int4 (BIGSERIAL, but every id in this schema is
// well inside 2^31-1). A non-integer path segment reaches Sequelize as-is and
// Postgres rejects it with 22P02, surfacing as a 500; gating the segment here
// turns it into a 400 at the route boundary. The 10-digit cap plus the int4
// ceiling also rejects values Postgres would raise 22003 ("out of range") for.
const MAX_INT4 = 2147483647;
const POSITIVE_INT_PATTERN = /^[1-9]\d{0,9}$/;

// True only for a canonical, positive int4 decimal string. Exported so query-
// string filters (vehicleId) share the same gate as path params.
function isInt4Id(raw) {
  return typeof raw === 'string'
    && POSITIVE_INT_PATTERN.test(raw)
    && Number(raw) <= MAX_INT4;
}

function validateIds(...keys) {
  return function validateIdParams(req, res, next) {
    for (const key of keys) {
      const raw = req.params && req.params[key];
      if (!isInt4Id(raw)) {
        return res.status(400).json({ error: `Invalid ${key}.` });
      }
    }
    return next();
  };
}

// ── LLM provider allowlist ─────────────────────────────────────────────────

const PROVIDER_ALLOWLIST = ['openai', 'anthropic', 'ollama', 'deepseek', 'custom'];

function validateProvider(provider) {
  if (provider === undefined || provider === null) {
    return { ok: true };
  }
  if (!PROVIDER_ALLOWLIST.includes(provider)) {
    return { ok: false, error: `llmProvider must be one of: ${PROVIDER_ALLOWLIST.join(', ')}` };
  }
  return { ok: true };
}

// ── Map tile provider (basemap) allowlist ─────────────────────────────────

// 'osm' is the default (keyless) provider; 'carto' is the opt-in upgrade that
// requires the admin's CARTO API key. Mirrors the CHECK constraint added by
// migration 021_add_map_tile_settings.sql.
const TILES_ALLOWLIST = ['osm', 'carto'];

function validateTileProvider(tileProvider) {
  if (tileProvider === undefined) {
    return { ok: true };
  }
  const schema = Joi.string().valid(...TILES_ALLOWLIST);
  const { error, value } = schema.validate(tileProvider);
  if (error) {
    return { ok: false, error: `tileProvider must be one of ${TILES_ALLOWLIST.join(', ')}` };
  }
  return { ok: true, value };
}

// The admin's CARTO API key. Trimming normalizes " " → '' (blank key allowed
// — the choice to use CARTO is still exposed, the frontend declines to render
// CARTO tiles without the key); the 255 cap both rejects junk payloads and
// keeps the value well inside the TEXT column's practical bounds.
const MAX_CARTO_API_KEY_LENGTH = 255;

function validateCartoApiKey(cartoApiKey) {
  if (cartoApiKey === undefined) {
    return { ok: true };
  }
  const schema = Joi.string().trim().max(MAX_CARTO_API_KEY_LENGTH).allow('');
  const { error, value } = schema.validate(cartoApiKey);
  if (error) {
    return { ok: false, error: `cartoApiKey must be a string of at most ${MAX_CARTO_API_KEY_LENGTH} characters.` };
  }
  return { ok: true, value };
}

// ── PUT /api/settings body ────────────────────────────────────────────────
//
// The single list of keys updateSettings accepts. Every rule mirrors the shape
// the handler already accepted (see the deleted inline checks): booleans are
// strict (the old `typeof === 'boolean'`), the numeric fields that used a
// Number() cast still coerce numeric strings, and retentionDays/
// analysisRetentionDays stay strict numbers. `.unknown(false)` turns a typo'd
// or stale field into a 400 instead of silently ignoring it — every key the
// SPA sends (SettingsPage, AiProviderCard, MapBasemapCard) is listed here.
//
// llmEndpoint is only shape-checked here: the URL/userinfo/protocol checks
// stay in the handler because they need `new URL` semantics.
const settingsUpdateSchema = Joi.object({
  disableRegistration: Joi.boolean().strict(),
  uploadApiToken: Joi.string().min(1).allow(null).strict(),
  llmProvider: Joi.string().valid(...PROVIDER_ALLOWLIST).allow(null),
  llmModel: Joi.string().max(200).allow(null, '').strict(),
  llmEndpoint: Joi.string().allow(null).strict(),
  llmApiKey: Joi.string().allow(null, '').strict(),
  vehicleMake: Joi.string().max(255).allow(null, ''),
  vehicleModel: Joi.string().max(255).allow(null, ''),
  vehicleYear: Joi.number().integer().min(1900).max(2099).allow(null),
  engineCc: Joi.number().integer().min(50).max(20000).allow(null),
  llmThinkingMode: Joi.boolean().strict(),
  llmReasoningEffort: Joi.string().valid('low', 'medium', 'high', 'max').allow(null),
  llmMaxTokens: Joi.number().integer().min(2048).max(32768),
  timezoneOffset: Joi.number().integer().min(-720).max(840),
  retentionEnabled: Joi.boolean().strict(),
  retentionDays: Joi.number().strict().integer().min(90).max(365),
  analysisRetentionDays: Joi.number().strict().integer()
    .min(90).message('analysisRetentionDays must be between 90 and 365.')
    .max(365).message('analysisRetentionDays must be between 90 and 365.')
    .allow(null),
  tileProvider: Joi.string().valid(...TILES_ALLOWLIST),
  cartoApiKey: Joi.string().trim().max(MAX_CARTO_API_KEY_LENGTH).allow(''),
}).unknown(false);

// Per-user display preference (plan 045). NOT a settings key: the preference
// lives on Users and has its own endpoint. null = inherit DEFAULT_UNIT_SYSTEM.
const preferencesSchema = Joi.object({
  unitSystem: Joi.string().valid('metric', 'us', 'uk').allow(null).required(),
});

// CSV export unit override (`?units=`). Absent → the caller's saved preference.
const csvUnitsSchema = Joi.object({
  units: Joi.string().valid('metric', 'us', 'uk').optional(),
});

// ── Pure validation helpers (legacy) ───────────────────────────────────────

function validateLlmThinkingMode(v) {
  if (typeof v !== 'boolean') {
    return { ok: false, error: 'llmThinkingMode must be a boolean.' };
  }
  return { ok: true };
}

function validateLlmMaxTokens(v) {
  const t = Number(v);
  if (!Number.isInteger(t) || t < 2048 || t > 32768) {
    return { ok: false, error: 'llmMaxTokens must be an integer between 2048 and 32768.' };
  }
  return { ok: true, value: t };
}

function validateRetentionEnabled(v) {
  if (typeof v !== 'boolean') {
    return { ok: false, error: 'retentionEnabled must be a boolean.' };
  }
  return { ok: true };
}

function validateRetentionDays(v) {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return { ok: false, error: 'retentionDays must be an integer.' };
  }
  if (v < 90 || v > 365) {
    return { ok: false, error: 'retentionDays must be between 90 and 365.' };
  }
  return { ok: true };
}

// Analysis-retention window for the app-side Analyses prune job. Mirrors
// validateRetentionDays (same 90–365 allowed set) but additionally accepts
// null/undefined to represent the DISABLED state — the Settings column is
// nullable and NULL means "do not prune analyses".
function validateAnalysisRetentionDays(v) {
  if (v === null || v === undefined) {
    return { ok: true };
  }
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    return { ok: false, error: 'analysisRetentionDays must be an integer.' };
  }
  if (v < 90 || v > 365) {
    return { ok: false, error: 'analysisRetentionDays must be between 90 and 365.' };
  }
  return { ok: true };
}

module.exports = {
  // Joi schemas
  renameSchema,
  notesSchema,
  cutSchema,
  filterSchema,
  copySchema,
  joinSchema,
  addLocationSchema,
  vehicleCreateSchema,
  vehicleUpdateSchema,
  settingsUpdateSchema,
  preferencesSchema,
  csvUnitsSchema,
  telemetryRangeSchema,
  validateIds,
  isInt4Id,
  MAX_INT4,
  // Provider validation
  PROVIDER_ALLOWLIST,
  validateProvider,
  // Map tile provider validation
  TILES_ALLOWLIST,
  validateTileProvider,
  validateCartoApiKey,
  MAX_CARTO_API_KEY_LENGTH,
  // Legacy helpers
  validateLlmThinkingMode,
  validateLlmMaxTokens,
  validateRetentionEnabled,
  validateRetentionDays,
  validateAnalysisRetentionDays,
};
