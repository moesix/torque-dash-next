'use strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── 1. Test that join SQL includes ON CONFLICT DO NOTHING ─────────────
describe('SessionController join — ON CONFLICT DO NOTHING', () => {
  test('join INSERT…SELECT includes ON CONFLICT clause', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../controllers/SessionController.js'),
      'utf8'
    );
    const matches = src.match(/ON CONFLICT \("sessionId", timestamp\) DO NOTHING/g);
    assert.ok(matches, 'Expected ON CONFLICT clause in join SQL');
    assert.ok(matches.length >= 2, `Expected ≥2 ON CONFLICT matches, got ${matches.length}`);
  });
});

// ── 2. Test that flush chunks rows into ≤1000-row batches ────────────
describe('ingestBuffer.flush — chunked bulkCreate', () => {
  test('flush with >1000 rows calls bulkCreate multiple times (ceil(rows/1000))', async () => {
    let bulkCreateCallCount = 0;
    let totalRowsInserted = 0;
    const mockLog = {
      bulkCreate: async (rows, _opts) => {
        bulkCreateCallCount++;
        totalRowsInserted += rows.length;
        assert.ok(rows.length <= 1000, `Chunk size ${rows.length} exceeds 1000`);
        return rows;
      }
    };

    const mockModels = { Log: mockLog };
    const modelsPath = require.resolve('../models');
    const originalCache = require.cache[modelsPath];
    require.cache[modelsPath] = {
      id: modelsPath,
      filename: modelsPath,
      loaded: true,
      exports: mockModels,
    };

    const ingestBufferPath = require.resolve('../services/ingestBuffer');
    const originalIngestBufferCache = require.cache[ingestBufferPath];
    delete require.cache[ingestBufferPath];

    try {
      const { ingest, flush } = require('../services/ingestBuffer');

      // Ingest 2500 rows — auto-flush fires at 1000 and 2000 (BATCH_SIZE),
      // then we manually flush the remaining 500. Total: 3 calls.
      for (let i = 0; i < 2500; i++) {
        ingest({
          userId: 1,
          sessionId: 's1',
          time: Date.now() + i,
          lon: 0,
          lat: 0,
          values: {},
          engineRpm: 1000,
          vehicleSpeed: 60,
        });
      }

      // The for loop is synchronous; auto-flush at 1000 and 2000 rows is
      // fire-and-forget. Yield to the event loop so the auto-flush's
      // `await Log.bulkCreate(...)` resolves and `flushing` resets to false
      // before we call flush() manually for the remaining 500 rows.
      await new Promise(r => setTimeout(r, 10));

      await flush();

      assert.strictEqual(bulkCreateCallCount, 3,
        `Expected 3 bulkCreate calls for 2500 rows (1000+1000+500), got ${bulkCreateCallCount}`);
      assert.strictEqual(totalRowsInserted, 2500,
        `Expected 2500 total rows inserted, got ${totalRowsInserted}`);
    } finally {
      if (originalCache) {
        require.cache[modelsPath] = originalCache;
      } else {
        delete require.cache[modelsPath];
      }
      if (originalIngestBufferCache) {
        require.cache[ingestBufferPath] = originalIngestBufferCache;
      } else {
        delete require.cache[ingestBufferPath];
      }
    }
  });

  test('flush passes returning:false to bulkCreate', async () => {
    let receivedOpts = null;
    const mockLog = {
      bulkCreate: async (rows, _opts) => {
        receivedOpts = _opts;
        return rows;
      }
    };

    const mockModels = { Log: mockLog };
    const modelsPath = require.resolve('../models');
    const originalCache = require.cache[modelsPath];
    require.cache[modelsPath] = {
      id: modelsPath,
      filename: modelsPath,
      loaded: true,
      exports: mockModels,
    };

    const ingestBufferPath = require.resolve('../services/ingestBuffer');
    const originalIngestBufferCache = require.cache[ingestBufferPath];
    delete require.cache[ingestBufferPath];

    try {
      const { ingest, flush } = require('../services/ingestBuffer');

      ingest({
        userId: 1,
        sessionId: 's1',
        time: Date.now(),
        lon: 0,
        lat: 0,
        values: {},
        engineRpm: 1000,
        vehicleSpeed: 60,
      });

      await flush();

      assert.strictEqual(receivedOpts.returning, false,
        'Expected returning:false in bulkCreate options');
      assert.strictEqual(receivedOpts.ignoreDuplicates, true,
        'Expected ignoreDuplicates:true in bulkCreate options');
    } finally {
      if (originalCache) {
        require.cache[modelsPath] = originalCache;
      } else {
        delete require.cache[modelsPath];
      }
      if (originalIngestBufferCache) {
        require.cache[ingestBufferPath] = originalIngestBufferCache;
      } else {
        delete require.cache[ingestBufferPath];
      }
    }
  });
});

// ── 3. Test that res.write false triggers drain wait ──────────────────
describe('SessionController exportCsv — drain backpressure', () => {
  test('res.write returning false triggers drain event wait', async () => {
    // Pre-populate models cache with mock
    const mockLogRows = [
      { id: 1, timestamp: 1000, lat: 1.0, lon: 2.0, engine_rpm: 3000, vehicle_speed: 60, values: {} },
      { id: 2, timestamp: 2000, lat: 1.1, lon: 2.1, engine_rpm: 3100, vehicle_speed: 61, values: {} },
    ];

    const mockModels = {
      Session: {
        findOne: async () => ({
          id: 's1',
          name: 'Test',
          toJSON() { return this; }
        }),
      },
      Log: {
        findAll: async () => mockLogRows,
        count: async () => 0,
      },
      User: { findOne: async () => ({ id: 1 }) },
      Vehicle: { findOne: async () => null },
      sequelize: {
        query: async () => [[]],
        transaction: async (fn) => fn({}),
        fn: () => {},
        col: () => {},
      },
      Sequelize: { Op: { gt: Symbol('gt'), or: Symbol('or') } },
    };

    const modelsPath = require.resolve('../models');
    const originalCache = require.cache[modelsPath];
    require.cache[modelsPath] = {
      id: modelsPath,
      filename: modelsPath,
      loaded: true,
      exports: mockModels,
    };

    const sessionControllerPath = require.resolve('../controllers/SessionController');
    const originalSCCache = require.cache[sessionControllerPath];
    delete require.cache[sessionControllerPath];

    try {
      const SessionController = require('../controllers/SessionController');

      let writeCount = 0;
      let drainHandlerAttached = false;
      const written = [];

      const res = {
        headersSent: false,
        setHeader() {},
        set() {},
        write(line) {
          writeCount++;
          written.push(line);
          // Return false on first data-row write (after header) to simulate backpressure
          // The header is write #1, first data row is write #2
          if (writeCount === 2) {
            process.nextTick(() => {
              if (res._drainCallback) {
                res._drainCallback();
              }
            });
            return false;
          }
          return true;
        },
        end() {},
        _drainCallback: null,
        once(event, cb) {
          if (event === 'drain') {
            drainHandlerAttached = true;
            res._drainCallback = cb;
          }
        },
      };

      const req = {
        user: { id: 1 },
        params: { sessionId: 's1' },
      };

      await SessionController.exportCsv(req, res);

      // The header row is written via res.write, then data rows use drain-aware write.
      // With 2 log rows, we expect: 1 header + 2 data rows = 3 writes total.
      assert.ok(writeCount >= 2,
        `Expected at least 2 writes (header + data), got ${writeCount}`);
      assert.ok(drainHandlerAttached,
        'Expected drain event handler to be attached during export');
    } finally {
      if (originalCache) {
        require.cache[modelsPath] = originalCache;
      } else {
        delete require.cache[modelsPath];
      }
      if (originalSCCache) {
        require.cache[sessionControllerPath] = originalSCCache;
      } else {
        delete require.cache[sessionControllerPath];
      }
    }
  });
});

// ── 4. Regression: HEAD must short-circuit before any DB work ──────────
// The client fires HEAD /api/sessions/:id/export/csv as a reachability/auth
// pre-check before the real download; Express dispatches HEAD to the GET
// handler. exportCsv must answer 200 right after the ownership check WITHOUT
// running PID discovery or the paginated Log scan — previously HEAD ran the
// full export with the body discarded, doubling every download's server work
// and spending an extra exportLimiter credit per click.
describe('SessionController exportCsv — HEAD short-circuit', () => {
  test('HEAD returns 200 and never calls the paginated query', async () => {
    let logFindAllCalls = 0;
    let sequelizeQueryCalls = 0;

    const mockModels = {
      Session: {
        findOne: async () => ({ id: 's-head-1', name: 'Head Test' }),
      },
      Log: {
        findAll: async () => { logFindAllCalls++; return []; },
        count: async () => 0,
      },
      User: { findOne: async () => ({ id: 1 }) },
      Vehicle: { findOne: async () => null },
      sequelize: {
        query: async () => { sequelizeQueryCalls++; return [[]]; },
        transaction: async (fn) => fn({}),
        fn: () => {},
        col: () => {},
      },
      Sequelize: { Op: { gt: Symbol('gt'), or: Symbol('or') } },
    };

    const modelsPath = require.resolve('../models');
    const originalCache = require.cache[modelsPath];
    require.cache[modelsPath] = {
      id: modelsPath,
      filename: modelsPath,
      loaded: true,
      exports: mockModels,
    };

    const sessionControllerPath = require.resolve('../controllers/SessionController');
    const originalSCCache = require.cache[sessionControllerPath];
    delete require.cache[sessionControllerPath];

    try {
      const SessionController = require('../controllers/SessionController');

      let ended = false;
      const res = {
        headersSent: false,
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        setHeader() {},
        set() {},
        write() { throw new Error('HEAD must not write a body'); },
        json() { throw new Error('HEAD must not return JSON'); },
        end() { ended = true; },
      };

      const req = {
        method: 'HEAD',
        user: { id: 1 },
        params: { sessionId: 's-head-1' },
      };

      await SessionController.exportCsv(req, res);

      assert.ok(ended, 'HEAD short-circuit should end the response');
      assert.strictEqual(res.statusCode, 200, 'HEAD should answer 200');
      assert.strictEqual(logFindAllCalls, 0,
        'Log.findAll (paginated scan) must NOT run for HEAD');
      assert.strictEqual(sequelizeQueryCalls, 0,
        'PID discovery SQL must NOT run for HEAD');
    } finally {
      if (originalCache) {
        require.cache[modelsPath] = originalCache;
      } else {
        delete require.cache[modelsPath];
      }
      if (originalSCCache) {
        require.cache[sessionControllerPath] = originalSCCache;
      } else {
        delete require.cache[sessionControllerPath];
      }
    }
  });
});
