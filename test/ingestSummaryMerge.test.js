'use strict';

// Focused unit coverage for the single denormalized-summary merge path:
// mergeWrittenRows' generated SQL, its absent-column omission, and the
// process-local write lock that serializes ingest merges against authoritative
// recomputes. Mirrors the mock-model injection pattern of
// test/summaryDenormalization.test.js.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');

function makeMockModels(overrides = {}) {
  return {
    Session: {
      findOne: async () => null,
      findAll: async () => [],
      update: async () => [1],
      ...overrides.Session,
    },
    Log: {
      findOne: async () => null,
      findAll: async () => [],
      ...overrides.Log,
    },
    sequelize: {
      query: async () => [],
      fn: (...args) => ({ _fn: args[0], _args: args.slice(1) }),
      col: (name) => ({ _col: name }),
      ...overrides.sequelize,
    },
  };
}

function loadWithMocks(mockModels) {
  const modelsPath = require.resolve('../models');
  const originalModels = require.cache[modelsPath];
  require.cache[modelsPath] = {
    id: modelsPath,
    filename: modelsPath,
    loaded: true,
    exports: mockModels,
  };

  const summariesPath = require.resolve('../services/sessionSummaries');
  const originalSummaries = require.cache[summariesPath];
  delete require.cache[summariesPath];

  return {
    mod: require('../services/sessionSummaries'),
    restore() {
      if (originalModels) require.cache[modelsPath] = originalModels;
      else delete require.cache[modelsPath];
      if (originalSummaries) require.cache[summariesPath] = originalSummaries;
      else delete require.cache[summariesPath];
    },
  };
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mergeWrittenRows — one monotonic statement', () => {
  test('builds a single UPDATE with LEAST/GREATEST and bound replacements', async () => {
    const calls = [];
    const mockModels = makeMockModels({
      sequelize: { query: async (sql, opts) => { calls.push({ sql, opts }); return []; } },
    });
    const { mod, restore } = loadWithMocks(mockModels);
    try {
      const min = new Date('2026-05-01T09:00:00Z');
      const max = new Date('2026-05-01T13:00:00Z');
      await mod.mergeWrittenRows(7, [
        { timestamp: max, engine_rpm: 1200, vehicle_speed: 40 },
        { timestamp: min, engine_rpm: 5000, vehicle_speed: 120 },
        { timestamp: min, engine_rpm: 3000, vehicle_speed: 80 },
      ]);

      assert.strictEqual(calls.length, 1, 'exactly one UPDATE per session');
      const { sql, opts } = calls[0];
      assert.match(sql, /^UPDATE "Sessions" SET /);
      assert.match(sql, /"firstTimestamp" = LEAST\(COALESCE\("firstTimestamp", :minTs\), :minTs\)/);
      assert.match(sql, /"lastTimestamp" = GREATEST\(COALESCE\("lastTimestamp", :maxTs\), :maxTs\)/);
      assert.match(sql, /"maxRpm" = GREATEST\(COALESCE\("maxRpm", :maxRpm\), :maxRpm\)/);
      assert.match(sql, /"maxSpeed" = GREATEST\(COALESCE\("maxSpeed", :maxSpeed\), :maxSpeed\)/);
      assert.match(sql, /WHERE id = :id$/);
      assert.deepStrictEqual(opts.replacements, { id: 7, minTs: min, maxTs: max, maxRpm: 5000, maxSpeed: 120 });
    } finally {
      restore();
    }
  });

  test('never clears a column contributed nothing — it is omitted from the SET', async () => {
    const calls = [];
    const mockModels = makeMockModels({
      sequelize: { query: async (sql, opts) => { calls.push({ sql, opts }); return []; } },
    });
    const { mod, restore } = loadWithMocks(mockModels);
    try {
      const t = new Date('2026-06-01T08:00:00Z');
      await mod.mergeWrittenRows(8, [
        { timestamp: t, engine_rpm: null, vehicle_speed: undefined },
      ]);

      assert.strictEqual(calls.length, 1);
      const { sql, opts } = calls[0];
      assert.ok(!/"maxRpm"/.test(sql), 'a null-only rpm batch must not name maxRpm');
      assert.ok(!/"maxSpeed"/.test(sql), 'a null-only speed batch must not name maxSpeed');
      assert.match(sql, /"firstTimestamp"/);
      assert.match(sql, /"lastTimestamp"/);
      assert.deepStrictEqual(opts.replacements, { id: 8, minTs: t, maxTs: t });
    } finally {
      restore();
    }
  });

  test('empty row set or missing id is a no-op (no statement)', async () => {
    const calls = [];
    const mockModels = makeMockModels({
      sequelize: { query: async (sql, opts) => { calls.push({ sql, opts }); return []; } },
    });
    const { mod, restore } = loadWithMocks(mockModels);
    try {
      await mod.mergeWrittenRows(9, []);
      await mod.mergeWrittenRows(null, [{ timestamp: new Date(), engine_rpm: 1, vehicle_speed: 1 }]);
      assert.strictEqual(calls.length, 0);
    } finally {
      restore();
    }
  });

  test('all-null row set is a no-op (nothing to widen)', async () => {
    const calls = [];
    const mockModels = makeMockModels({
      sequelize: { query: async (sql, opts) => { calls.push({ sql, opts }); return []; } },
    });
    const { mod, restore } = loadWithMocks(mockModels);
    try {
      await mod.mergeWrittenRows(10, [{ timestamp: null, engine_rpm: null, vehicle_speed: null }]);
      assert.strictEqual(calls.length, 0);
    } finally {
      restore();
    }
  });
});

describe('summary write lock — writers never interleave', () => {
  test('a merge started first settles before a concurrent recompute starts', async () => {
    const events = [];
    const mockModels = makeMockModels({
      sequelize: {
        query: async () => {
          events.push('merge:start');
          await tick(30);
          events.push('merge:end');
          return [];
        },
      },
      Log: {
        findOne: async () => ({
          start: '2026-04-01T00:00:00Z',
          end: '2026-04-01T02:00:00Z',
          maxSpeed: 100,
          maxRpm: 4000,
        }),
      },
      Session: {
        update: async () => {
          events.push('recompute:start');
          await tick(5);
          events.push('recompute:end');
          return [1];
        },
      },
    });
    const { mod, restore } = loadWithMocks(mockModels);
    try {
      const merge = mod.mergeWrittenRows(11, [
        { timestamp: new Date('2026-04-01T00:30:00Z'), engine_rpm: 3500, vehicle_speed: 90 },
      ]);
      const recompute = mod.recomputeSummary(11);
      await Promise.all([merge, recompute]);

      assert.deepStrictEqual(events, [
        'merge:start',
        'merge:end',
        'recompute:start',
        'recompute:end',
      ], 'the second writer must wait for the first to settle');
    } finally {
      restore();
    }
  });

  test('a recompute started first settles before a concurrent merge starts', async () => {
    const events = [];
    const mockModels = makeMockModels({
      Log: {
        findOne: async () => ({
          start: '2026-04-02T00:00:00Z',
          end: '2026-04-02T02:00:00Z',
          maxSpeed: 110,
          maxRpm: 4100,
        }),
      },
      Session: {
        update: async () => {
          events.push('recompute:start');
          await tick(30);
          events.push('recompute:end');
          return [1];
        },
      },
      sequelize: {
        query: async () => {
          events.push('merge:start');
          await tick(5);
          events.push('merge:end');
          return [];
        },
      },
    });
    const { mod, restore } = loadWithMocks(mockModels);
    try {
      const recompute = mod.recomputeSummary(12);
      const merge = mod.mergeWrittenRows(12, [
        { timestamp: new Date('2026-04-02T00:30:00Z'), engine_rpm: 3600, vehicle_speed: 95 },
      ]);
      await Promise.all([recompute, merge]);

      assert.deepStrictEqual(events, [
        'recompute:start',
        'recompute:end',
        'merge:start',
        'merge:end',
      ], 'the second writer must wait for the first to settle');
    } finally {
      restore();
    }
  });
});
