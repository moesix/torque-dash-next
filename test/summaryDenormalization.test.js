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
