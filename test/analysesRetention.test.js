'use strict';

// Plan 121 (option A): app-side scheduled Analyses prune job.
//
// Mocks ../models via the require.cache pattern (see sessionLifecycle /
// analysisJournal / adminGate tests). The service reads Settings via
// getSingleton() and destroys Analysis rows via Analysis.destroy({ where }).
//
// The module keeps a `started` flag and a module-level timer, so each test
// re-requires a FRESH copy of the service (delete require.cache entry) to
// reset idempotency state between cases.

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Op } = require('sequelize');

const servicePath = require.resolve('../services/analysesRetention');

// Per-test mutable state
let settingsRow;
let destroyCalls;
let destroyImpl;

function makeSettingsRow() {
  return {
    id: 1,
    retentionEnabled: false,
    retentionDays: 365,
    analysisRetentionDays: null,
  };
}

const mockModels = {
  Settings: {
    getSingleton: async () => settingsRow,
  },
  Analysis: {
    destroy: async (opts) => {
      destroyCalls.push(opts);
      if (destroyImpl) return destroyImpl(opts);
      return { rowsDeleted: 0 };
    },
  },
  sequelize: { query: async () => [] },
};

// Resolve the absolute path that `require('../models')` resolves to, then
// inject our mock into the cache BEFORE the service is required.
const modelsPath = require.resolve('../models');
require.cache[modelsPath] = {
  id: modelsPath,
  filename: modelsPath,
  loaded: true,
  exports: mockModels,
};

function freshService() {
  delete require.cache[servicePath];
  return require('../services/analysesRetention');
}

beforeEach(() => {
  settingsRow = makeSettingsRow();
  destroyCalls = [];
  destroyImpl = null;
  mockModels.Settings.getSingleton = async () => settingsRow;
  delete require.cache[servicePath];
});

// ── pruneAnalysesOnce ────────────────────────────────────────────────

describe('pruneAnalysesOnce', () => {
  test('disabled when analysisRetentionDays is null — destroy NOT called', async () => {
    settingsRow.analysisRetentionDays = null;
    const { pruneAnalysesOnce } = freshService();

    const result = await pruneAnalysesOnce();

    assert.deepStrictEqual(result, { pruned: 0, enabled: false });
    assert.strictEqual(destroyCalls.length, 0, 'destroy must not run when disabled');
  });

  test('disabled when analysisRetentionDays is 0/negative', async () => {
    const { pruneAnalysesOnce } = freshService();

    settingsRow.analysisRetentionDays = 0;
    assert.deepStrictEqual(await pruneAnalysesOnce(), { pruned: 0, enabled: false });

    settingsRow.analysisRetentionDays = -30;
    assert.deepStrictEqual(await pruneAnalysesOnce(), { pruned: 0, enabled: false });
    assert.strictEqual(destroyCalls.length, 0);
  });

  test('destroys Analyses older than the cutoff when days is set', async () => {
    settingsRow.analysisRetentionDays = 30;
    destroyImpl = async () => ({ rowsDeleted: 7 });
    const { pruneAnalysesOnce } = freshService();

    const before = Date.now();
    const result = await pruneAnalysesOnce();
    const after = Date.now();

    assert.strictEqual(destroyCalls.length, 1);
    assert.strictEqual(result.pruned, 7);
    assert.strictEqual(result.enabled, true);

    const where = destroyCalls[0].where;
    assert.ok(where.createdAt, 'destroy must filter on createdAt');
    const cutoff = where.createdAt[Op.lt];
    assert.ok(cutoff, 'cutoff must be stored under Op.lt');

    // Cutoff must sit within a few seconds of now − 30 days.
    const lowerBound = before - 30 * 24 * 60 * 60 * 1000 - 5000;
    const upperBound = after - 30 * 24 * 60 * 60 * 1000 + 5000;
    const cutoffMs = new Date(cutoff).getTime();
    assert.ok(cutoffMs >= lowerBound && cutoffMs <= upperBound,
      `cutoff ${new Date(cutoff).toISOString()} should be ~now−30d`);
  });

  test('destroy is NOT scoped to a user (retention is a global operator setting)', async () => {
    settingsRow.analysisRetentionDays = 90;
    destroyImpl = async () => ({ rowsDeleted: 3 });
    const { pruneAnalysesOnce } = freshService();

    const result = await pruneAnalysesOnce();

    assert.strictEqual(result.pruned, 3);
    const where = destroyCalls[0].where;
    assert.strictEqual(where.userId, undefined, 'the prune must sweep across ALL users');
  });

  test('Settings.getSingleton throwing returns { error } and does NOT throw', async () => {
    mockModels.Settings.getSingleton = async () => {
      throw new Error('db down');
    };
    const { pruneAnalysesOnce } = freshService();

    let result;
    await assert.doesNotReject(async () => {
      result = await pruneAnalysesOnce();
    });

    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.pruned, 0);
    assert.ok(result.error, 'error message should be surfaced in the result');
    assert.strictEqual(destroyCalls.length, 0);
  });

  test('Analysis.destroy throwing returns { error } and does NOT throw (job resilience)', async () => {
    settingsRow.analysisRetentionDays = 90;
    destroyImpl = async () => { throw new Error('destroy boom'); };
    const { pruneAnalysesOnce } = freshService();

    let result;
    await assert.doesNotReject(async () => {
      result = await pruneAnalysesOnce();
    });

    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.pruned, 0);
    assert.ok(result.error);
  });
});

// ── startAnalysesPruner ──────────────────────────────────────────────

describe('startAnalysesPruner', () => {
  test('returns a handle exposing unref and is idempotent on second call', () => {
    const { startAnalysesPruner, CHECK_INTERVAL_MS } = freshService();

    assert.strictEqual(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000, 'interval must be 6h');

    const handle = startAnalysesPruner(50);
    assert.ok(handle, 'first call must return the timer handle');
    assert.strictEqual(typeof handle.unref, 'function', 'handle must expose unref');

    const second = startAnalysesPruner(50);
    assert.strictEqual(second, null, 'second call must return null (idempotent)');

    // Clean up so the timer does not keep the test process alive.
    clearInterval(handle);
  });

  test('does not start when already started in a previous call within the same module copy', () => {
    const { startAnalysesPruner } = freshService();
    const handle1 = startAnalysesPruner(5000);
    const handle2 = startAnalysesPruner(5000);
    assert.strictEqual(handle2, null);
    clearInterval(handle1);
  });
});
