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

// ── 5. ingestBuffer flush — per-chunk / per-row failure isolation ─────
// These drive the REAL flush() against mocked models (require.cache pattern
// from the chunking suite above). Every harness load gets a fresh module, so
// the buffer starts empty and attempt counters start at 0.

describe('ingestBuffer.flush — failure isolation', () => {
  // Build a fresh ingestBuffer whose Log.bulkCreate delegates to `impl`
  // (throw to fail a write) and whose Session summary merge is recorded.
  function loadFlushHarness({ bulkCreate, findByPk, update }) {
    const calls = { bulkCreate: [], findByPk: [], update: [] };
    const mockModels = {
      Log: {
        async bulkCreate(rows, opts) {
          calls.bulkCreate.push({ rows, opts });
          return bulkCreate(rows, opts);
        },
      },
      Session: {
        async findByPk(id, opts) {
          calls.findByPk.push({ id, opts });
          return findByPk ? findByPk(id, opts) : null;
        },
        async update(vals, opts) {
          calls.update.push({ vals, opts });
          return update ? update(vals, opts) : [1];
        },
      },
    };

    const modelsPath = require.resolve('../models');
    const originalModelsCache = require.cache[modelsPath];
    require.cache[modelsPath] = {
      id: modelsPath,
      filename: modelsPath,
      loaded: true,
      exports: mockModels,
    };

    const ibPath = require.resolve('../services/ingestBuffer');
    const originalIBCache = require.cache[ibPath];
    delete require.cache[ibPath];

    return {
      ingestBuffer: require('../services/ingestBuffer'),
      calls,
      restore() {
        if (originalModelsCache) {
          require.cache[modelsPath] = originalModelsCache;
        } else {
          delete require.cache[modelsPath];
        }
        if (originalIBCache) {
          require.cache[ibPath] = originalIBCache;
        } else {
          delete require.cache[ibPath];
        }
      },
    };
  }

  function bufferedRow(sessionId, msOffset, values = {}) {
    return {
      userId: 1,
      sessionId,
      time: new Date(1700000000000 + msOffset),
      lon: 0,
      lat: 0,
      values,
      engineRpm: 1000,
      vehicleSpeed: 60,
    };
  }

  // Chunk 1 (1000 rows, session A) fails; chunk 2 (500 rows, session B) is
  // written. Only B may be summarized, and A's rows must be the only ones back
  // in the buffer.
  test('a failing chunk does not re-queue or summarize a succeeding chunk', async () => {
    const SESSION_A = 'iso-chunk-a';
    const SESSION_B = 'iso-chunk-b';
    let writtenRowCount = 0;

    const { ingestBuffer, calls, restore } = loadFlushHarness({
      bulkCreate: async (rows) => {
        if (rows.some((r) => r.sessionId === SESSION_A)) throw new Error('chunk A rejected');
        writtenRowCount += rows.length;
        return rows;
      },
      findByPk: async (id) => ({
        id,
        firstTimestamp: null,
        lastTimestamp: null,
        maxRpm: null,
        maxSpeed: null,
      }),
    });

    try {
      // 1000 A rows trip BATCH_SIZE, so the auto-flush splices exactly that
      // chunk; the 500 B rows ingested meanwhile land in the now-empty buffer.
      // Pass 1 fails the A chunk — a first failure re-queues it wholesale — and
      // re-queues it in FRONT of B. Assert that settling state first, so the
      // next pass's chunking is pinned rather than inferred.
      for (let i = 0; i < 1000; i++) ingestBuffer.ingest(bufferedRow(SESSION_A, i));
      for (let i = 0; i < 500; i++) ingestBuffer.ingest(bufferedRow(SESSION_B, 1000 + i));

      // Let the fire-and-forget pass settle (a macrotask flushes all microtasks
      // without starting drain's extra pass).
      await new Promise((r) => setImmediate(r));

      assert.strictEqual(writtenRowCount, 0, 'the auto-flushed A chunk wrote nothing');
      assert.strictEqual(ingestBuffer.size(), 1500,
        'pass 1 requeued the 1000 A rows in front of the 500 buffered B rows');

      // Pass 2 is drain's forced pass over two chunks: A (1000, now on its
      // second failure, so it bisects down to single rows that all fail) and
      // B (500, written). Bisection burns the isolation budget but never lands
      // an A row, so only B may be summarized.
      await ingestBuffer.drain();

      assert.strictEqual(writtenRowCount, 500,
        'only the succeeding chunk (500 rows) reached the DB');
      assert.strictEqual(ingestBuffer.size(), 1000,
        'exactly the failing chunk is back in the buffer');
      assert.deepStrictEqual(calls.findByPk.map((c) => c.id), [SESSION_B],
        'summary merge must run for the written session only');
      assert.deepStrictEqual(calls.update.map((c) => c.opts.where), [{ id: SESSION_B }],
        'Session.update must target the written session only');
    } finally {
      restore();
    }
  });

  // One poisoned row must not take its healthy neighbours down with it: the
  // first failure re-queues the chunk, the repeat failure bisects down to the
  // single bad row.
  test('a single poison row is isolated by bisection; healthy rows persist', async () => {
    const SESSION = 'bisect-session';
    let writtenRowCount = 0;

    const { ingestBuffer, calls, restore } = loadFlushHarness({
      bulkCreate: async (rows) => {
        if (rows.some((r) => r.values && r.values.poison)) throw new Error('poison row rejected');
        writtenRowCount += rows.length;
        return rows;
      },
      findByPk: async (id) => ({ id, firstTimestamp: null, lastTimestamp: null }),
    });

    try {
      for (let i = 0; i < 5; i++) ingestBuffer.ingest(bufferedRow(SESSION, i));
      ingestBuffer.ingest(bufferedRow(SESSION, 5, { poison: true })); // last row

      await ingestBuffer.flush(); // first failure: whole chunk re-queued
      assert.strictEqual(ingestBuffer.size(), 6, 'first failure re-queues the whole chunk');
      assert.strictEqual(writtenRowCount, 0, 'nothing written on the first failure');
      assert.strictEqual(calls.findByPk.length, 0, 'no summary merge when nothing was written');

      await ingestBuffer.flush(); // repeat failure: bisect
      assert.strictEqual(writtenRowCount, 5, 'five healthy rows written');
      assert.strictEqual(ingestBuffer.size(), 1, 'only the poison row is re-queued');
      assert.deepStrictEqual(calls.findByPk.map((c) => c.id), [SESSION],
        'summary merge runs for the written session');

      // The poison row alone advances its attempt counter once per cycle.
      await ingestBuffer.flush();
      assert.strictEqual(ingestBuffer.size(), 1, 'still retrying (below MAX_RETRIES)');
    } finally {
      restore();
    }
  });

  test('a row that keeps failing is dropped after MAX_RETRIES cycles and logged with sessionId/timestamp', async () => {
    const SESSION = 'drop-session';
    const { ingestBuffer, restore } = loadFlushHarness({
      bulkCreate: async () => { throw new Error('always fails'); },
    });

    const logged = [];
    const originalError = console.error;
    console.error = (...args) => { logged.push(args); };
    try {
      ingestBuffer.ingest(bufferedRow(SESSION, 0));

      // attempts 1..3 keep the row; the fourth failure exceeds MAX_RETRIES.
      for (let i = 0; i < 3; i++) {
        await ingestBuffer.flush();
        assert.strictEqual(ingestBuffer.size(), 1, `row survives cycle ${i + 1}`);
      }
      await ingestBuffer.flush();
      assert.strictEqual(ingestBuffer.size(), 0, 'row dropped after MAX_RETRIES + 1 failures');
    } finally {
      console.error = originalError;
      restore();
    }

    const dropLog = logged.find((args) =>
      typeof args[0] === 'string' && args[0].includes('dropping row after max retries'));
    assert.ok(dropLog, 'drop must be logged');
    assert.strictEqual(dropLog[1].sessionId, SESSION);
    assert.ok(dropLog[1].timestamp instanceof Date, 'drop log keeps the timestamp field');
  });
});

// ── 6. ingestBuffer.drain() ──────────────────────────────────────────

describe('ingestBuffer.drain — quiesce before Log mutations', () => {
  function loadHarness(bulkCreate) {
    const mockModels = {
      Log: { bulkCreate },
      Session: { findByPk: async () => null },
    };
    const modelsPath = require.resolve('../models');
    const originalModelsCache = require.cache[modelsPath];
    require.cache[modelsPath] = {
      id: modelsPath,
      filename: modelsPath,
      loaded: true,
      exports: mockModels,
    };
    const ibPath = require.resolve('../services/ingestBuffer');
    const originalIBCache = require.cache[ibPath];
    delete require.cache[ibPath];
    return {
      ingestBuffer: require('../services/ingestBuffer'),
      restore() {
        if (originalModelsCache) {
          require.cache[modelsPath] = originalModelsCache;
        } else {
          delete require.cache[modelsPath];
        }
        if (originalIBCache) {
          require.cache[ibPath] = originalIBCache;
        } else {
          delete require.cache[ibPath];
        }
      },
    };
  }

  test('drain writes a non-empty buffer and leaves zero rows', async () => {
    const { ingestBuffer, restore } = loadHarness(async (rows) => rows);
    try {
      for (let i = 0; i < 4; i++) {
        ingestBuffer.ingest({
          userId: 1, sessionId: 'drain-1', time: new Date(1700000000000 + i),
          lon: 0, lat: 0, values: {}, engineRpm: null, vehicleSpeed: null,
        });
      }
      assert.strictEqual(ingestBuffer.size(), 4);

      await ingestBuffer.drain();

      assert.strictEqual(ingestBuffer.size(), 0, 'drain leaves nothing buffered');
    } finally {
      restore();
    }
  });

  test('drain called during a flush waits for it and then flushes rows ingested meanwhile', async () => {
    let releaseFirst = null;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    let bulkCreateCalls = 0;

    const { ingestBuffer, restore } = loadHarness(async (rows) => {
      bulkCreateCalls += 1;
      if (bulkCreateCalls === 1) await firstGate; // hold the first pass open
      return rows;
    });

    try {
      ingestBuffer.ingest({
        userId: 1, sessionId: 'drain-2', time: new Date(1700000000000),
        lon: 0, lat: 0, values: {}, engineRpm: null, vehicleSpeed: null,
      });

      const firstFlush = ingestBuffer.flush(); // takes the row, blocks on the gate

      let drainResolved = false;
      const drained = ingestBuffer.drain().then(() => { drainResolved = true; });

      // A row that arrives while the first pass is in flight must be covered
      // by drain's extra pass.
      ingestBuffer.ingest({
        userId: 1, sessionId: 'drain-2', time: new Date(1700000001000),
        lon: 0, lat: 0, values: {}, engineRpm: null, vehicleSpeed: null,
      });

      await new Promise((r) => setTimeout(r, 10));
      assert.strictEqual(drainResolved, false, 'drain must wait for the in-flight flush');

      releaseFirst();
      await Promise.all([firstFlush, drained]);

      assert.strictEqual(ingestBuffer.size(), 0, 'both passes completed');
      assert.strictEqual(bulkCreateCalls, 2, 'drain forced one more pass for the late row');
    } finally {
      restore();
    }
  });

  // Regression: sibling drains must serialize their WHOLE bodies, including the
  // forced pass. The previous two-loop drain could settle the earlier drain
  // while a later sibling's pass was already holding rows in flight — its
  // caller (a Log mutation) would then write under an in-flight pass. Here the
  // first pass awaits a gate and then fails (transient), re-queueing all 30
  // rows; the second pass awaits its own gate so it is observably in flight
  // while d1's settlement is checked.
  test('overlapping drains serialize: no drain settles while a sibling pass holds rows', async () => {
    let passesInFlight = 0;
    let bulkCreateCalls = 0;
    let writtenRows = 0;
    let releaseFirstPass;
    let releaseSecondPass;
    const firstPassGate = new Promise((resolve) => { releaseFirstPass = resolve; });
    const secondPassGate = new Promise((resolve) => { releaseSecondPass = resolve; });

    const events = [];
    const { ingestBuffer, restore } = loadHarness(async (rows) => {
      const call = ++bulkCreateCalls;
      passesInFlight += 1;
      events.push(`pass${call}-start`);
      try {
        if (call === 1) {
          await firstPassGate; // held open while both drains start
          throw new Error('transient DB failure');
        }
        if (call === 2) await secondPassGate; // hold d2's pass in flight
        writtenRows += rows.length;
        return rows;
      } finally {
        passesInFlight -= 1;
      }
    });

    try {
      for (let i = 0; i < 30; i++) {
        ingestBuffer.ingest({
          userId: 1, sessionId: 'drain-overlap', time: new Date(1700000000000 + i),
          lon: 0, lat: 0, values: {}, engineRpm: null, vehicleSpeed: null,
        });
      }

      const settledWhileInFlight = [];
      const observe = (tag) => () => {
        events.push(`${tag}-settled`);
        if (passesInFlight > 0) settledWhileInFlight.push(tag);
      };

      const d1 = ingestBuffer.drain().then(observe('d1'));
      await new Promise((r) => setImmediate(r)); // d1's pass is now in flight
      const d2 = ingestBuffer.drain().then(observe('d2'));
      await new Promise((r) => setImmediate(r));

      assert.strictEqual(passesInFlight, 1, 'the first pass is held open');
      assert.strictEqual(bulkCreateCalls, 1, 'only the first pass has started');

      releaseFirstPass(); // pass 1 fails; its 30 rows are re-queued
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // d1 is done, d2's forced pass is running and blocked on its gate.
      assert.strictEqual(passesInFlight, 1, 'the second pass holds rows in flight');
      assert.deepStrictEqual(settledWhileInFlight, [],
        'no drain may settle while a pass holds rows in flight');
      assert.ok(events.indexOf('d1-settled') !== -1 &&
        events.indexOf('d1-settled') < events.indexOf('pass2-start'),
        `d2's pass must start only after d1 settled (${events.join(', ')})`);

      releaseSecondPass();
      await Promise.all([d1, d2]);

      assert.strictEqual(passesInFlight, 0, 'every pass completed');
      assert.strictEqual(ingestBuffer.size(), 0, 'the re-queued rows were written');
      assert.strictEqual(writtenRows, 30, 'all 30 rows reached the DB exactly once');
      assert.strictEqual(bulkCreateCalls, 2, 'one failed pass + one successful pass');
      assert.deepStrictEqual(settledWhileInFlight, [],
        'neither drain resolved while a pass held rows in flight');
    } finally {
      restore();
    }
  });
});

// ── 7. deleted session mid-buffer — poison rows are isolated per session ──

describe('ingestBuffer.flush — deleted session mid-buffer', () => {
  test('an FK violation for a deleted session only drops that session\'s rows', async () => {
    const DELETED = 'session-deleted';
    const HEALTHY = 'session-healthy';
    let healthyRowsWritten = 0;
    const summarized = [];

    const calls = [];
    const mockModels = {
      Log: {
        async bulkCreate(rows) {
          calls.push(rows.length);
          if (rows.some((r) => r.sessionId === DELETED)) {
            // Stands in for the sync-created FK violation once the row is gone.
            throw new Error('insert or update on table "Logs" violates foreign key constraint');
          }
          healthyRowsWritten += rows.length;
          return rows;
        },
      },
      Session: {
        async findByPk(id) { summarized.push(id); return { id, firstTimestamp: null, lastTimestamp: null }; },
        async update() { return [1]; },
      },
    };

    const modelsPath = require.resolve('../models');
    const originalModelsCache = require.cache[modelsPath];
    require.cache[modelsPath] = {
      id: modelsPath,
      filename: modelsPath,
      loaded: true,
      exports: mockModels,
    };
    const ibPath = require.resolve('../services/ingestBuffer');
    const originalIBCache = require.cache[ibPath];
    delete require.cache[ibPath];

    try {
      const { ingest, flush, size } = require('../services/ingestBuffer');

      for (let i = 0; i < 3; i++) {
        ingest({
          userId: 1, sessionId: HEALTHY, time: new Date(1700000000000 + i),
          lon: 0, lat: 0, values: {}, engineRpm: null, vehicleSpeed: null,
        });
      }
      for (let i = 0; i < 3; i++) {
        ingest({
          userId: 1, sessionId: DELETED, time: new Date(1700000001000 + i),
          lon: 0, lat: 0, values: {}, engineRpm: null, vehicleSpeed: null,
        });
      }

      // Cycle 1: the mixed chunk fails wholesale (rows had no retry history).
      await flush();
      assert.strictEqual(healthyRowsWritten, 0);
      assert.strictEqual(size(), 6, 'all six rows re-queued');

      // Cycle 2: bisection writes the healthy half, isolates the deleted rows.
      await flush();
      assert.strictEqual(healthyRowsWritten, 3, 'healthy session rows written despite the FK failure');
      assert.strictEqual(size(), 3, 'only the deleted session rows remain');
      assert.ok(!summarized.includes(DELETED),
        'a session whose rows never landed must not get a summary merge');

      // Cycles 3 and 4: the orphaned rows advance to MAX_RETRIES and drop.
      await flush();
      await flush();
      assert.strictEqual(size(), 0, 'orphaned rows dropped, healthy rows unaffected');
      assert.strictEqual(healthyRowsWritten, 3, 'healthy rows are never re-written');
      assert.ok(calls.length > 0);
    } finally {
      if (originalModelsCache) {
        require.cache[modelsPath] = originalModelsCache;
      } else {
        delete require.cache[modelsPath];
      }
      if (originalIBCache) {
        require.cache[ibPath] = originalIBCache;
      } else {
        delete require.cache[ibPath];
      }
    }
  });
});

// ── 8. Structural: every Log-mutating handler drains the ingest buffer first ──
// Same source-structure style as the join ON CONFLICT guard above. A buffered
// frame that lands after a mutation resurrects a deleted range or is invisible
// to a snapshot, so the drain must precede the FIRST Log-mutating statement.
describe('SessionController — drain before Log mutations', () => {
  const MUTATING = [
    [/Log\.destroy\s*\(/, 'Log.destroy()'],
    [/Log\.update\s*\(/, 'Log.update()'],
    [/\.destroy\s*\(/, 'destroy()'],
    [/sequelize\.query\s*\(/, 'raw SQL (sequelize.query)'],
  ];

  // Body of one static handler, up to the next class method.
  function handlerBody(src, name) {
    const marker = `    static async ${name}(req, res) {`;
    const start = src.indexOf(marker);
    assert.notStrictEqual(start, -1, `handler ${name} not found in SessionController`);
    const rest = src.slice(start + marker.length);
    const end = rest.indexOf('\n    static async ');
    return end === -1 ? rest : rest.slice(0, end);
  }

  for (const name of ['delete', 'filter', 'cut', 'copy', 'join']) {
    test(`${name} awaits drainIngest() before its first Log mutation`, () => {
      const src = fs.readFileSync(
        path.resolve(__dirname, '../controllers/SessionController.js'),
        'utf8'
      );
      const body = handlerBody(src, name);

      const drainAt = body.indexOf('await drainIngest()');
      assert.notStrictEqual(drainAt, -1, `${name} must call await drainIngest()`);

      let mutationAt = -1;
      let mutationLabel = null;
      for (const [re, label] of MUTATING) {
        const m = re.exec(body);
        if (m && (mutationAt === -1 || m.index < mutationAt)) {
          mutationAt = m.index;
          mutationLabel = label;
        }
      }
      assert.notStrictEqual(mutationAt, -1,
        `${name} is expected to mutate Logs (no mutation pattern matched)`);
      assert.ok(drainAt < mutationAt,
        `${name}: drainIngest() at offset ${drainAt} must precede ${mutationLabel} at offset ${mutationAt}`);
    });
  }
});

// ── 9. Behaviour: delete drains → reads → destroys → evicts the upload cache ──
describe('SessionController.delete — drain and evictSession wiring', () => {
  function makeRes() {
    const r = { statusCode: null, body: null };
    r.status = (code) => { r.statusCode = code; return r; };
    r.json = (body) => { r.body = body; return r; };
    r.sendStatus = (code) => { r.statusCode = code; return r; };
    return r;
  }

  // Load SessionController with the ingest buffer and the upload cache evictor
  // stubbed, recording every call in `events` so ORDER is assertable.
  function loadDeleteHarness(row) {
    const events = [];
    const mockModels = {
      Session: {
        async findOne() { events.push('findOne'); return row; },
        async destroy() { events.push('destroy'); return 1; },
      },
      Log: {},
      User: {},
      Vehicle: {},
      sequelize: {},
      Sequelize: { Op: {} },
    };

    const modelsPath = require.resolve('../models');
    const originalModelsCache = require.cache[modelsPath];
    require.cache[modelsPath] = {
      id: modelsPath, filename: modelsPath, loaded: true, exports: mockModels,
    };

    const ibPath = require.resolve('../services/ingestBuffer');
    const originalIBCache = require.cache[ibPath];
    require.cache[ibPath] = {
      id: ibPath, filename: ibPath, loaded: true,
      exports: { async drain() { events.push('drain'); } },
    };

    const uploadPath = require.resolve('../controllers/UploadController');
    const originalUploadCache = require.cache[uploadPath];
    require.cache[uploadPath] = {
      id: uploadPath, filename: uploadPath, loaded: true,
      exports: { evictSession(...args) { events.push(['evict', ...args]); } },
    };

    const scPath = require.resolve('../controllers/SessionController');
    const originalSCCache = require.cache[scPath];

    function restore() {
      if (originalModelsCache) require.cache[modelsPath] = originalModelsCache;
      else delete require.cache[modelsPath];
      if (originalIBCache) require.cache[ibPath] = originalIBCache;
      else delete require.cache[ibPath];
      if (originalUploadCache) require.cache[uploadPath] = originalUploadCache;
      else delete require.cache[uploadPath];
      if (originalSCCache) require.cache[scPath] = originalSCCache;
      else delete require.cache[scPath];
    }

    try {
      delete require.cache[scPath];
      return {
        SessionController: require('../controllers/SessionController'),
        events,
        restore,
      };
    } catch (err) {
      // A throw while loading must not leave the stubbed cache entries in place.
      restore();
      throw err;
    }
  }

  test('delete drains, then destroys, then evicts the deleted session key', async () => {
    let restore;
    try {
      const harness = loadDeleteHarness({ id: 's1', sessionId: 'device-session-1' });
      restore = harness.restore;
      const { SessionController, events } = harness;
      const res = makeRes();
      await SessionController.delete(
        { user: { id: 7 }, params: { sessionId: 's1' } },
        res
      );

      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(events, [
        'drain',
        'findOne',
        'destroy',
        ['evict', 'device-session-1', 7],
      ], 'order must be drain → findOne → destroy → evict(sessionId, userId)');
    } finally {
      if (restore) restore();
    }
  });

  test('404 path destroys and evicts nothing', async () => {
    let restore;
    try {
      const harness = loadDeleteHarness(null);
      restore = harness.restore;
      const { SessionController, events } = harness;
      const res = makeRes();
      await SessionController.delete(
        { user: { id: 7 }, params: { sessionId: 'missing' } },
        res
      );

      assert.strictEqual(res.statusCode, 404);
      assert.deepStrictEqual(res.body, { error: 'Session not found' });
      assert.deepStrictEqual(events, ['drain', 'findOne'],
        'a missing session must not be destroyed or evicted');
    } finally {
      if (restore) restore();
    }
  });
});
