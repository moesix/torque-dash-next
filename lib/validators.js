'use strict';

/**
 * Pure validation helpers extracted from controllers/UserController.js
 * (updateSettings). Each returns { ok: true } or { ok: false, error: '<msg>' }
 * with messages identical to the originals.
 */

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
  validateLlmThinkingMode,
  validateLlmMaxTokens,
  validateRetentionEnabled,
  validateRetentionDays,
};
