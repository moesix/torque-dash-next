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

const copySchema = Joi.object({
  name: Joi.string().min(1).required(),
});

const joinSchema = Joi.object({
  joinSessionId: Joi.number().integer().positive().required(),
  name: Joi.string().min(1).required(),
});

const addLocationSchema = Joi.object({
  locations: Joi.object({
    start: Joi.string().required(),
    end: Joi.string().required(),
  }).required(),
});

const vehicleCreateSchema = Joi.object({
  name: Joi.string().min(1).required(),
  make: Joi.string().allow(null, '').optional(),
  model: Joi.string().allow(null, '').optional(),
  year: Joi.number().integer().min(1900).max(2099).allow(null).optional(),
  engineCc: Joi.number().integer().min(50).optional(),
  vin: Joi.string().allow(null, '').optional(),
});

const vehicleUpdateSchema = Joi.object({
  name: Joi.string().min(1).optional(),
  make: Joi.string().allow(null, '').optional(),
  model: Joi.string().allow(null, '').optional(),
  year: Joi.number().integer().min(1900).max(2099).allow(null).optional(),
  engineCc: Joi.number().integer().min(50).allow(null).optional(),
  vin: Joi.string().allow(null, '').optional(),
}).min(1);

const telemetryRangeSchema = Joi.object({
  from: Joi.date().iso().required(),
  to: Joi.date().iso().required(),
  limit: Joi.number().integer().min(1).max(10000).default(5000),
  offset: Joi.number().integer().min(0).default(0),
});

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
  telemetryRangeSchema,
  // Provider validation
  PROVIDER_ALLOWLIST,
  validateProvider,
  // Legacy helpers
  validateLlmThinkingMode,
  validateLlmMaxTokens,
  validateRetentionEnabled,
  validateRetentionDays,
};
