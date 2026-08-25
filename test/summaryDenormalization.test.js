'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');

// ── Pre-populate require.cache for ../models ────────────────────────
// We mock Session/Log/sequelize so we can test the logic without a DB.

function makeMockModels(overrides = {}) {
  return {
    Session: {
      findOne: async () => null,
      findAll: async () => [],
      count: async () => 0,
      update: async () => [1],
      create: async () => ({}),
      destroy: async () => 0,
      ...overrides.Session,
    },
    Log: {
      count: async () => 0,
      findAll: async () => [],
      destroy: async () => 0,
      ...overrides.Log,
    },
    User: { findOne: async () => null },
    Vehicle: { findOne: async () => null },
    sequelize: {
      transaction: async (fn) => fn({}),
      query: async () => [],
      fn: (...args) => ({ _fn: args[0], _args: args.slice(1) }),
      col: (name) => ({ _col: name }),
      ...overrides.sequelize,
    },
    Sequelize: { Op: { and: Symbol('and'), gt: Symbol('gt'), lte: Symbol('lte') } },
  };
}

function loadWithMocks(mockModels) {
  const modelsPath = require.resolve('../models');
  const originalCache = require.cache[modelsPath];
  require.cache[modelsPath] = {
    id: modelsPath,
    filename: modelsPath,
    loaded: true,
    exports: mockModels,
  };

  const scPath = require.resolve('../controllers/SessionController');
  const originalSCCache = require.cache[scPath];
  delete require.cache[scPath];

  // Also manage the ingestBuffer module cache so tests can drive the REAL
  // flush() against mocked models (fresh module => fresh empty buffer).
  const ibPath = require.resolve('../services/ingestBuffer');
  const originalIBCache = require.cache[ibPath];
  delete require.cache[ibPath];

  return {
    restore() {
      if (originalCache) {
        require.cache[modelsPath] = originalCache;
      } else {
        delete require.cache[modelsPath];
      }
      if (originalSCCache) {
        require.cache[scPath] = originalSCCache;
      } else {
        delete require.cache[scPath];
      }
      if (originalIBCache) {
        require.cache[ibPath] = originalIBCache;
      } else {
        delete require.cache[ibPath];
      }
    }
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('aggregateSummaries — reads from Session columns', () => {
  test('returns denormalized columns when firstTimestamp is present', async () => {
    const mockSessions = [
      { id: 's1', firstTimestamp: '2026-01-01T00:00:00Z', lastTimestamp: '2026-01-01T01:00:00Z', maxRpm: 5000, maxSpeed: 120 },
      { id: 's2', firstTimestamp: '2026-02-01T00:00:00Z', lastTimestamp: '2026-02-01T02:00:00Z', maxRpm: 6000, maxSpeed: 150 },
    ];
    const mockModels = makeMockModels({
      Session: { findAll: async () => mockSessions },
    });

    const { restore } = loadWithMocks(mockModels);
    try {
      const { aggregateSummaries } = require('../controllers/SessionController');
      const map = await aggregateSummaries(['s1', 's2']);

      assert.strictEqual(map.size, 2);
      assert.strictEqual(map.get('s1').start, '2026-01-01T00:00:00Z');
      assert.strictEqual(map.get('s1').maxRpm, 5000);
      assert.strictEqual(map.get('s1').maxSpeed, 120);
      assert.strictEqual(map.get('s2').maxRpm, 6000);
      assert.strictEqual(map.get('s2').maxSpeed, 150);
    } finally {
      restore();
    }
  });

  test('falls back to Log aggregate when firstTimestamp is NULL', async () => {
    const mockSessions = [
      { id: 's1', firstTimestamp: null, lastTimestamp: null, maxRpm: null, maxSpeed: null },
    ];
    let logQueryCount = 0;
    const mockLogRows = [{
      dataValues: {
        sessionId: 's1',
        start: '2026-03-01T00:00:00Z',
        end: '2026-03-01T03:00:00Z',
        maxSpeed: 200,
        maxRpm: 7000,
      }
    }];

    const mockModels = makeMockModels({
      Session: { findAll: async () => mockSessions },
      Log: {
        findAll: async () => { logQueryCount++; return mockLogRows; },
      },
    });

    const { restore } = loadWithMocks(mockModels);
    try {
      const { aggregateSummaries } = require('../controllers/SessionController');
      const map = await aggregateSummaries(['s1']);

      assert.strictEqual(logQueryCount, 1, 'Should fall back to Log.findAll');
      assert.strictEqual(map.size, 1);
      assert.strictEqual(map.get('s1').start, '2026-03-01T00:00:00Z');
      assert.strictEqual(map.get('s1').maxSpeed, 200);
      assert.strictEqual(map.get('s1').maxRpm, 7000);
    } finally {
      restore();
    }
  });

  test('returns empty map for empty sessionIds', async () => {
    const mockModels = makeMockModels();
    const { restore } = loadWithMocks(mockModels);
    try {
      const { aggregateSummaries } = require('../controllers/SessionController');
      const map = await aggregateSummaries([]);
      assert.strictEqual(map.size, 0);
    } finally {
      restore();
    }
  });

  test('returns empty map for null sessionIds', async () => {
    const mockModels = makeMockModels();
    const { restore } = loadWithMocks(mockModels);
    try {
      const { aggregateSummaries } = require('../controllers/SessionController');
      const map = await aggregateSummaries(null);
      assert.strictEqual(map.size, 0);
    } finally {
      restore();
    }
  });
});

describe('recomputeSummary — updates Session columns', () => {
  test('updates Session with aggregated Log values', async () => {
    let updateArgs = null;
    const mockModels = makeMockModels({
      Log: {
        findOne: async () => ({
          start: '2026-04-01T00:00:00Z',
          end: '2026-04-01T02:00:00Z',
          maxSpeed: 180,
          maxRpm: 5500,
        }),
      },
      Session: {
        update: async (vals, opts) => { updateArgs = { vals, opts }; return [1]; },
      },
    });

    const { restore } = loadWithMocks(mockModels);
    try {
      const { recomputeSummary } = require('../controllers/SessionController');
      await recomputeSummary('s1');

      assert.ok(updateArgs, 'Session.update should be called');
      assert.strictEqual(updateArgs.vals.firstTimestamp, '2026-04-01T00:00:00Z');
      assert.strictEqual(updateArgs.vals.lastTimestamp, '2026-04-01T02:00:00Z');
      assert.strictEqual(updateArgs.vals.maxRpm, 5500);
      assert.strictEqual(updateArgs.vals.maxSpeed, 180);
      assert.deepStrictEqual(updateArgs.opts.where, { id: 's1' });
    } finally {
      restore();
    }
  });

  test('handles empty Log result (no logs)', async () => {
    let updateCalled = false;
    const mockModels = makeMockModels({
      Log: { findOne: async () => null },
      Session: {
        update: async () => { updateCalled = true; return [0]; },
      },
    });

    const { restore } = loadWithMocks(mockModels);
    try {
      const { recomputeSummary } = require('../controllers/SessionController');
      await recomputeSummary('s_empty');
      assert.strictEqual(updateCalled, false, 'Session.update should not be called when Log.findOne returns null');
    } finally {
      restore();
    }
  });
});

describe('Session model — has denormalized summary columns', () => {
  test('Session model defines firstTimestamp, lastTimestamp, maxRpm, maxSpeed', () => {
    const fs = require('fs');
    const path = require('path');
    const sessionSrc = fs.readFileSync(
      path.resolve(__dirname, '../models/Session.js'),
      'utf8'
    );
    assert.ok(sessionSrc.includes('firstTimestamp'), 'Session model should define firstTimestamp');
    assert.ok(sessionSrc.includes('lastTimestamp'), 'Session model should define lastTimestamp');
    assert.ok(sessionSrc.includes('maxRpm'), 'Session model should define maxRpm');
    assert.ok(sessionSrc.includes('maxSpeed'), 'Session model should define maxSpeed');
  });
});

describe('Migration 016 — idempotent SQL', () => {
  test('migration file exists and uses ADD COLUMN IF NOT EXISTS', () => {
    const fs = require('fs');
    const path = require('path');
    const migrationPath = path.resolve(__dirname, '../infra/timescale/016_denormalize_summaries.sql');
    assert.ok(fs.existsSync(migrationPath), 'Migration 016 should exist');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS'), 'Should use ADD COLUMN IF NOT EXISTS for idempotency');
    assert.ok(sql.includes('"firstTimestamp"'), 'Should add firstTimestamp column');
    assert.ok(sql.includes('"lastTimestamp"'), 'Should add lastTimestamp column');
    assert.ok(sql.includes('"maxRpm"'), 'Should add maxRpm column');
    assert.ok(sql.includes('"maxSpeed"'), 'Should add maxSpeed column');
    assert.ok(sql.includes('UPDATE'), 'Should include backfill UPDATE');
    assert.ok(sql.includes('IS NULL'), 'Backfill should use IS NULL guard');
  });
});

describe('ingestBuffer — has LEAST/GREATEST summary merge', () => {
  test('ingestBuffer.js uses LEAST and GREATEST for summary updates', () => {
    const fs = require('fs');
    const path = require('path');
    const bufSrc = fs.readFileSync(
      path.resolve(__dirname, '../services/ingestBuffer.js'),
      'utf8'
    );
    assert.ok(bufSrc.includes('LEAST'), 'ingestBuffer should use LEAST for firstTimestamp merge');
    assert.ok(bufSrc.includes('GREATEST'), 'ingestBuffer should use GREATEST for lastTimestamp/maxRpm/maxSpeed merge');
    assert.ok(bufSrc.includes('COALESCE'), 'ingestBuffer should use COALESCE to handle NULL existing values');
    assert.ok(bufSrc.includes('Session.update'), 'ingestBuffer should call Session.update');
    // Regression guards for plan 073: the old literal-SQL block referenced a
    // nonexistent "sub" alias and silently failed every flush. The merge must
    // stay in JS with plain bound parameters — no SQL literal fragments.
    assert.ok(!bufSrc.includes('sequelize.literal'),
      'ingestBuffer must not use sequelize.literal (broken sub-alias history)');
    assert.ok(!bufSrc.includes('sub.'),
      'ingestBuffer must not reference a "sub." SQL alias');
  });
});

describe('flush — real-path summary merge through ingestBuffer', () => {
  // Drives the ACTUAL flush() with mocked models capturing arguments.
  function makeFlushMocks({ findByPkResult }) {
    const updateCalls = [];
    const findByPkCalls = [];
    let bulkCreateCalls = 0;
    return {
      updateCalls,
      findByPkCalls,
      mockModels: {
        Session: {
          findByPk: async (id, opts) => {
            findByPkCalls.push({ id, opts });
            return typeof findByPkResult === 'function' ? findByPkResult(id) : findByPkResult;
          },
          update: async (vals, opts) => { updateCalls.push({ vals, opts }); return [1]; },
        },
        Log: {
          bulkCreate: async (rows) => { bulkCreateCalls += rows.length; return rows; },
        },
      },
      getBulkCreateCalls: () => bulkCreateCalls,
    };
  }

  test('wider batch bounds merge into existing session — exact update args', async () => {
    const T1 = new Date('2026-05-01T10:00:00Z'); // existing firstTimestamp
    const T2 = new Date('2026-05-01T12:00:00Z'); // existing lastTimestamp
    const before = new Date('2026-05-01T09:00:00Z');
    const after = new Date('2026-05-01T13:00:00Z');

    const { mockModels, updateCalls, findByPkCalls } = makeFlushMocks({
      // Plan spec: existing row has narrower bounds and smaller maxima.
      findByPkResult: { id: 7, firstTimestamp: T1, lastTimestamp: T2, maxRpm: 3000, maxSpeed: 80 },
    });

    const { restore } = loadWithMocks(mockModels);
    try {
      const { ingest, flush } = require('../services/ingestBuffer');

      // Three rows spanning wider bounds than the existing columns:
      // one timestamp before T1, one after T2, rpm 5000 (>3000), speed 120 (>80).
      ingest({ userId: 1, sessionId: 7, time: before, lon: 0, lat: 0, values: {}, engineRpm: 5000, vehicleSpeed: 60 });
      ingest({ userId: 1, sessionId: 7, time: T2, lon: 0, lat: 0, values: {}, engineRpm: 1000, vehicleSpeed: 120 });
      ingest({ userId: 1, sessionId: 7, time: after, lon: 0, lat: 0, values: {}, engineRpm: 2500, vehicleSpeed: 90 });

      await flush();

      assert.strictEqual(findByPkCalls.length, 1, 'one findByPk per affected session');
      assert.strictEqual(findByPkCalls[0].id, 7);
      assert.deepStrictEqual(findByPkCalls[0].opts.attributes,
        ['id', 'firstTimestamp', 'lastTimestamp', 'maxRpm', 'maxSpeed']);

      assert.strictEqual(updateCalls.length, 1, 'Session.update called exactly ONCE');
      assert.deepStrictEqual(updateCalls[0].vals, {
        firstTimestamp: before, // min(batch, existing)
        lastTimestamp: after,   // max(batch, existing)
        maxRpm: 5000,           // GREATEST(3000, 5000)
        maxSpeed: 120,          // GREATEST(80, 120)
      });
      assert.deepStrictEqual(updateCalls[0].opts, { where: { id: 7 } });
    } finally {
      restore();
    }
  });

  test('NULL existing columns coalesce — merged equals batch stats verbatim', async () => {
    const tA = new Date('2026-06-01T08:15:00Z');
    const tB = new Date('2026-06-01T09:45:00Z');

    const { mockModels, updateCalls } = makeFlushMocks({
      // Never-backfilled session: all denormalized columns NULL.
      findByPkResult: { id: 8, firstTimestamp: null, lastTimestamp: null, maxRpm: null, maxSpeed: null },
    });

    const { restore } = loadWithMocks(mockModels);
    try {
      const { ingest, flush } = require('../services/ingestBuffer');

      ingest({ userId: 1, sessionId: 8, time: tB, lon: 0, lat: 0, values: {}, engineRpm: 4500, vehicleSpeed: 95 });
      ingest({ userId: 1, sessionId: 8, time: tA, lon: 0, lat: 0, values: {}, engineRpm: 2000, vehicleSpeed: 50 });

      await flush();

      assert.strictEqual(updateCalls.length, 1, 'Session.update called exactly ONCE');
      assert.deepStrictEqual(updateCalls[0].vals, {
        firstTimestamp: tA,  // COALESCE(NULL, batchMin) -> batchMin
        lastTimestamp: tB,   // COALESCE(NULL, batchMax) -> batchMax
        maxRpm: 4500,        // COALESCE(NULL, 4500)     -> 4500
        maxSpeed: 95,        // COALESCE(NULL, 95)       -> 95
      }, 'NULL columns must be replaced by batch stats verbatim');
      assert.deepStrictEqual(updateCalls[0].opts, { where: { id: 8 } });
    } finally {
      restore();
    }
  });

  test('missing session (findByPk null) — no update, no throw', async () => {
    const { mockModels, updateCalls } = makeFlushMocks({ findByPkResult: null });

    const { restore } = loadWithMocks(mockModels);
    try {
      const { ingest, flush } = require('../services/ingestBuffer');

      ingest({ userId: 1, sessionId: 999, time: new Date('2026-07-01T00:00:00Z'), lon: 0, lat: 0, values: {}, engineRpm: 1500, vehicleSpeed: 40 });
      ingest({ userId: 1, sessionId: 999, time: new Date('2026-07-01T00:30:00Z'), lon: 0, lat: 0, values: {}, engineRpm: 1600, vehicleSpeed: 55 });

      // Must resolve without throwing despite the session not existing.
      await flush();

      assert.strictEqual(updateCalls.length, 0,
        'Session.update must NOT be called when the session is missing');
    } finally {
      restore();
    }
  });

  test('batch without rpm/speed keeps existing maxima (null-normalized merge)', async () => {
    const tA = new Date('2026-08-01T06:00:00Z');
    const tB = new Date('2026-08-01T06:10:00Z');

    const { mockModels, updateCalls } = makeFlushMocks({
      findByPkResult: { id: 11, firstTimestamp: tA, lastTimestamp: tB, maxRpm: 3200, maxSpeed: 88 },
    });

    const { restore } = loadWithMocks(mockModels);
    try {
      const { ingest, flush } = require('../services/ingestBuffer');

      // Rows carry no engineRpm / vehicleSpeed at all (nulls).
      ingest({ userId: 1, sessionId: 11, time: tA, lon: 0, lat: 0, values: {}, engineRpm: null, vehicleSpeed: null });
      ingest({ userId: 1, sessionId: 11, time: tB, lon: 0, lat: 0, values: {}, engineRpm: undefined, vehicleSpeed: undefined });

      await flush();

      assert.strictEqual(updateCalls.length, 1);
      assert.deepStrictEqual(updateCalls[0].vals, {
        firstTimestamp: tA,
        lastTimestamp: tB,
        maxRpm: 3200,  // existing preserved when batch contributes nothing
        maxSpeed: 88,
      }, 'absent batch metrics must not clobber existing column values');
    } finally {
      restore();
    }
  });
});

describe('SessionController — recomputeSummary calls', () => {
  test('recomputeSummary is called after copy, join, filter, cut', () => {
    const fs = require('fs');
    const path = require('path');
    const scSrc = fs.readFileSync(
      path.resolve(__dirname, '../controllers/SessionController.js'),
      'utf8'
    );
    const matches = scSrc.match(/recomputeSummary/g);
    assert.ok(matches, 'recomputeSummary should appear in SessionController');
    // 1 definition + 4 calls (copy, join, filter, cut) + 2 exports = at least 5
    assert.ok(matches.length >= 5,
      `Expected at least 5 occurrences of recomputeSummary (1 def + 4 calls + exports), got ${matches.length}`);
  });
});
