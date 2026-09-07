'use strict';

// Plan 121 (option A): app-side scheduled Analyses prune job.
//
// Mocks ../models via the require.cache pattern (see sessionLifecycle /
// analysisJournal / adminGate tests). The service reads Settings via
// getSingleton() and sweeps stale rows in BOUNDED id batches: each pass
// findAll({ where: { createdAt: { [Op.lt]: cutoff } }, attributes: ['id'],
// order: [['id','ASC']], limit: BATCH_SIZE }) then destroy({ where: { id:
// { [Op.in]: ids } } }), repeating until a short batch signals no more rows.
//
// The module keeps a `started` flag and a module-level timer, so each test
// re-requires a FRESH copy of the service (delete require.cache entry) to
// reset idempotency state between cases.

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { Op } = require('sequelize');

const origLog = console.log;
const origError = console.error;

const servicePath = require.resolve('../services/analysesRetention');

// Per-test mutable state
let settingsRow;
let findAllCalls;
let destroyCalls;
let findAllImpl;
let destroyImpl;
let consoleLogs;
let consoleErrors;

function makeSettingsRow() {
  return {
    id: 1,
    retentionEnabled: false,
    retentionDays: 365,
    analysisRetentionDays: null,
  };
}

// The models mock exposes the same queries the service uses. `allStaleIds`
// lets a test drive the findAll→destroy loop from a fixed set of stale ids,
// consuming them oldest-first so repeated batches behave like a real table.
const mockModels = {
  Settings: {
    getSingleton: async () => settingsRow,
  },
  Analysis: {
    findAll: async (opts) => {
      findAllCalls.push(opts);
      if (findAllImpl) return findAllImpl(opts);
      return [];
    },
    destroy: async (opts) => {
      destroyCalls.push(opts);
      if (destroyImpl) return destroyImpl(opts);
      return 0;
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
  findAllCalls = [];
  destroyCalls = [];
  findAllImpl = null;
  destroyImpl = null;
  consoleLogs = [];
  consoleErrors = [];
  mockModels.Settings.getSingleton = async () => settingsRow;
  // The service only logs via console.log/console.error — swap in spies so a
  // pass can assert its success/error logging.
  mockModels.Analysis.findAll = async (opts) => {
    findAllCalls.push(opts);
    if (findAllImpl) return findAllImpl(opts);
    return [];
  };
  mockModels.Analysis.destroy = async (opts) => {
    destroyCalls.push(opts);
    if (destroyImpl) return destroyImpl(opts);
    return 0;
  };
  // Swap the console methods so each test can assert the service's success
  // and failure logging; afterEach restores the real implementations.
  console.log = (...args) => { consoleLogs.push(args.join(' ')); };
  console.error = (...args) => { consoleErrors.push(args.join(' ')); };
  delete require.cache[servicePath];
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
});

// ── pruneAnalysesOnce ────────────────────────────────────────────────

describe('pruneAnalysesOnce', () => {
  test('disabled when analysisRetentionDays is null — no queries, no logs', async () => {
    settingsRow.analysisRetentionDays = null;
    const { pruneAnalysesOnce } = freshService();

    const result = await pruneAnalysesOnce();

    assert.deepStrictEqual(result, { pruned: 0, enabled: false });
    assert.strictEqual(findAllCalls.length, 0, 'findAll must not run when disabled');
    assert.strictEqual(destroyCalls.length, 0, 'destroy must not run when disabled');
    assert.strictEqual(consoleLogs.length, 0);
  });

  test('disabled when analysisRetentionDays is 0/negative', async () => {
    const { pruneAnalysesOnce } = freshService();

    settingsRow.analysisRetentionDays = 0;
    assert.deepStrictEqual(await pruneAnalysesOnce(), { pruned: 0, enabled: false });

    settingsRow.analysisRetentionDays = -30;
    assert.deepStrictEqual(await pruneAnalysesOnce(), { pruned: 0, enabled: false });
    assert.strictEqual(findAllCalls.length, 0);
    assert.strictEqual(destroyCalls.length, 0);
  });

  test('single batch destroys Analyses older than the cutoff when days is set', async () => {
    settingsRow.analysisRetentionDays = 30;
    // findAll returns fewer than BATCH_SIZE → one find, one destroy.
    findAllImpl = async () => [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id }));
    destroyImpl = async () => 7;
    const { pruneAnalysesOnce } = freshService();

    const before = Date.now();
    const result = await pruneAnalysesOnce();
    const after = Date.now();

    assert.strictEqual(result.pruned, 7);
    assert.strictEqual(result.enabled, true);

    assert.strictEqual(findAllCalls.length, 1, 'one findAll batch for a short page');
    const findOpts = findAllCalls[0];
    assert.strictEqual(findOpts.attributes.length, 1);
    assert.strictEqual(findOpts.attributes[0], 'id', 'batch select must fetch ids only');
    assert.deepStrictEqual(findOpts.order, [['id', 'ASC']], 'batches sweep oldest-first');
    assert.strictEqual(findOpts.limit, 5000, 'batch size must be 5000');

    const where = findOpts.where;
    assert.ok(where.createdAt, 'findAll must filter on createdAt');
    const cutoff = where.createdAt[Op.lt];
    assert.ok(cutoff, 'cutoff must be stored under Op.lt');

    // Cutoff must sit within a few seconds of now − 30 days.
    const lowerBound = before - 30 * 24 * 60 * 60 * 1000 - 5000;
    const upperBound = after - 30 * 24 * 60 * 60 * 1000 + 5000;
    const cutoffMs = new Date(cutoff).getTime();
    assert.ok(cutoffMs >= lowerBound && cutoffMs <= upperBound,
      `cutoff ${new Date(cutoff).toISOString()} should be ~now−30d`);

    // destroy is issued for exactly the fetched ids.
    assert.strictEqual(destroyCalls.length, 1);
    const destroyWhere = destroyCalls[0].where;
    assert.ok(destroyWhere.id[Op.in], 'destroy must filter by id IN (...ids)');
    assert.deepStrictEqual(destroyWhere.id[Op.in], [1, 2, 3, 4, 5, 6, 7]);
  });

  test('sweep is NOT scoped to a user (retention is a global operator setting)', async () => {
    settingsRow.analysisRetentionDays = 90;
    findAllImpl = async () => [10, 11, 12].map((id) => ({ id }));
    destroyImpl = async () => 3;
    const { pruneAnalysesOnce } = freshService();

    const result = await pruneAnalysesOnce();

    assert.strictEqual(result.pruned, 3);
    const where = findAllCalls[0].where;
    assert.strictEqual(where.userId, undefined, 'the prune must sweep across ALL users');
    const destroyWhere = destroyCalls[0].where;
    assert.strictEqual(destroyWhere.userId, undefined);
  });

  test('loops in bounded batches until a short page arrives, accumulating total', async () => {
    settingsRow.analysisRetentionDays = 30;
    // 12000 stale rows → two FULL batches (5000) + one short batch (2000).
    const allIds = Array.from({ length: 12000 }, (_, i) => i + 1);
    findAllImpl = async (opts) => {
      const firstUnconsumed = allIds.shift();
      if (firstUnconsumed == null) return [];
      const batch = allIds.splice(0, opts.limit - 1);
      return [firstUnconsumed, ...batch].map((id) => ({ id }));
    };
    destroyImpl = async (opts) => opts.where.id[Op.in].length;
    const { pruneAnalysesOnce } = freshService();

    const result = await pruneAnalysesOnce();

    assert.strictEqual(result.pruned, 12000);
    assert.strictEqual(result.enabled, true);
    assert.strictEqual(findAllCalls.length, 3, 'three findAll batches expected');
    assert.strictEqual(destroyCalls.length, 3, 'one destroy per batch expected');
    for (const c of findAllCalls) {
      assert.ok(c.limit <= 5000, 'every findAll batch respects the 5000 cap');
    }
    const destroyedIds = destroyCalls.flatMap((c) => c.where.id[Op.in]);
    assert.strictEqual(destroyedIds.length, 12000, 'every stale id is destroyed exactly once');
    assert.strictEqual(new Set(destroyedIds).size, 12000, 'no id is destroyed twice');
  });

  test('logs a success line with the pruned count and cutoff when pruned > 0', async () => {
    settingsRow.analysisRetentionDays = 30;
    findAllImpl = async () => [1, 2].map((id) => ({ id }));
    destroyImpl = async () => 2;
    const { pruneAnalysesOnce } = freshService();

    const result = await pruneAnalysesOnce();

    assert.strictEqual(result.pruned, 2);
    assert.strictEqual(consoleLogs.length, 1, 'one success log for a non-zero pass');
    assert.match(consoleLogs[0], /^\[analysesRetention\] pruned 2 analyses older than /);
  });

  test('does NOT log a success line when there is nothing to prune', async () => {
    settingsRow.analysisRetentionDays = 30;
    findAllImpl = async () => [];
    const { pruneAnalysesOnce } = freshService();

    const result = await pruneAnalysesOnce();

    assert.deepStrictEqual(result, { pruned: 0, enabled: true });
    assert.strictEqual(consoleLogs.length, 0, 'no log when the sweep found nothing');
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
    assert.strictEqual(findAllCalls.length, 0);
    assert.strictEqual(destroyCalls.length, 0);
    assert.strictEqual(consoleErrors.length, 1, 'the failure is logged');
    assert.match(consoleErrors[0], /^\[analysesRetention\] prune pass failed:/);
  });

  test('Analysis.findAll throwing mid-batch returns { error } and does NOT throw (job resilience)', async () => {
    settingsRow.analysisRetentionDays = 90;
    findAllImpl = async () => { throw new Error('findAll boom'); };
    const { pruneAnalysesOnce } = freshService();

    let result;
    await assert.doesNotReject(async () => {
      result = await pruneAnalysesOnce();
    });

    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.pruned, 0);
    assert.ok(result.error);
    assert.strictEqual(consoleErrors.length, 1);
    assert.match(consoleErrors[0], /^\[analysesRetention\] prune pass failed:/);
  });

  test('Analysis.destroy throwing returns { error } and does NOT throw (job resilience)', async () => {
    settingsRow.analysisRetentionDays = 90;
    findAllImpl = async () => [1, 2].map((id) => ({ id }));
    destroyImpl = async () => { throw new Error('destroy boom'); };
    const { pruneAnalysesOnce } = freshService();

    let result;
    await assert.doesNotReject(async () => {
      result = await pruneAnalysesOnce();
    });

    assert.strictEqual(result.enabled, false);
    assert.strictEqual(result.pruned, 0);
    assert.ok(result.error);
    assert.strictEqual(consoleErrors.length, 1);
    assert.match(consoleErrors[0], /^\[analysesRetention\] prune pass failed:/);
  });
});

// ── startAnalysesPruner ──────────────────────────────────────────────

describe('startAnalysesPruner', () => {
  test('returns a handle exposing unref and is idempotent on second call', () => {
    const { startAnalysesPruner, CHECK_INTERVAL_MS, BATCH_SIZE } = freshService();

    assert.strictEqual(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000, 'interval must be 6h');
    assert.strictEqual(BATCH_SIZE, 5000, 'batch size must be 5000');

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
