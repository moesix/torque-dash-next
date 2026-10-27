'use strict';

// Plan 082 — per-session PID key discovery cache (lib/pidRegistry.js) plus
// invalidation from services/ingestBuffer.flush()'s SUCCESS path.
//
// Harness: pre-populate require.cache for ../models so the real flush() can be
// driven against mocks (same pattern as summaryDenormalization.test.js).
// pidRegistry itself has no heavy deps, so it is required directly; its
// module-level pidKeyCache is a singleton shared between the test and a freshly
// loaded ingestBuffer, which is exactly what makes the integration assertions
// meaningful.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { discoverPidKeys, invalidatePidKeys } = require('../lib/pidRegistry');

// ── Helpers ────────────────────────────────────────────────────────────────

// Sequelize mock whose query() counts calls and resolves key rows per session
// id. Keys come back alphabetically sorted regardless of input order, mimicking
// the ORDER BY in the real SQL.
function makeSequelizeSpy(rowsBySession) {
    let queryCount = 0;
    const queriedSessions = [];
    return {
        get queryCount() { return queryCount; },
        get queriedSessions() { return queriedSessions.slice(); },
        sequelize: {
            async query(_sql, opts) {
                queryCount++;
                const sid = opts.replacements.sessionId;
                queriedSessions.push(sid);
                const keys = rowsBySession[sid] || [];
                return [keys.slice().sort().map(k => ({ key: k }))];
            },
        },
    };
}

// Load services/ingestBuffer fresh (empty buffer, new timer) against mocked
// models. Returns restore() to put the original module caches back.
function loadFreshIngestBuffer(mockModels) {
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

function makeMockModels({ bulkCreate }) {
    return {
        Log: { bulkCreate },
        // Summary merge (plan 073) runs even after a failed flush; returning
        // null keeps it inert so these tests only observe PID-cache effects.
        Session: { findByPk: async () => null },
    };
}

// ── discoverPidKeys caching behavior ───────────────────────────────────────

describe('discoverPidKeys — TTL cache', () => {
    test('first call queries DB once and caches result', async () => {
        const spy = makeSequelizeSpy({
            'cache-first-a': ['kc', 'k5', 'kd'], // unsorted on purpose
        });

        const keys = await discoverPidKeys('cache-first-a', spy.sequelize);

        assert.deepStrictEqual(keys, ['k5', 'kc', 'kd'], 'sorted k* keys returned');
        assert.strictEqual(spy.queryCount, 1, 'exactly one DB query on cold cache');
    });

    test('second call same sessionId hits cache — no additional query', async () => {
        const spy = makeSequelizeSpy({
            'cache-second-b': ['k5', 'kb'],
        });

        const first = await discoverPidKeys('cache-second-b', spy.sequelize);
        assert.strictEqual(spy.queryCount, 1);

        const second = await discoverPidKeys('cache-second-b', spy.sequelize);
        assert.strictEqual(spy.queryCount, 1, 'no additional query within TTL');
        assert.strictEqual(second, first, 'same array identity (cache hit)');
        assert.deepStrictEqual(second, ['k5', 'kb']);
    });

    test('different sessionId issues its own query', async () => {
        const spy = makeSequelizeSpy({
            'cache-multi-c': ['kc'],
            'cache-multi-d': ['kf', 'kd'],
        });

        const keysC = await discoverPidKeys('cache-multi-c', spy.sequelize);
        const keysD = await discoverPidKeys('cache-multi-d', spy.sequelize);

        assert.deepStrictEqual(keysC, ['kc']);
        assert.deepStrictEqual(keysD, ['kd', 'kf']);
        assert.strictEqual(spy.queryCount, 2, 'one query per distinct sessionId');
        assert.deepStrictEqual(spy.queriedSessions, ['cache-multi-c', 'cache-multi-d']);

        // Cached entries stay independent.
        assert.strictEqual(spy.queryCount, 2);
        await discoverPidKeys('cache-multi-c', spy.sequelize);
        assert.strictEqual(spy.queryCount, 2, 'session C stays cached after D lookup');
    });

    test('invalidatePidKeys forces the next call back to the DB', async () => {
        const spy = makeSequelizeSpy({
            'cache-inv-e': ['k5'],
        });

        await discoverPidKeys('cache-inv-e', spy.sequelize);
        assert.strictEqual(spy.queryCount, 1);

        invalidatePidKeys('cache-inv-e');

        const keys = await discoverPidKeys('cache-inv-e', spy.sequelize);
        assert.strictEqual(spy.queryCount, 2, 'invalidated entry triggers a fresh query');
        assert.deepStrictEqual(keys, ['k5']);

        // And the refreshed entry is cached again.
        await discoverPidKeys('cache-inv-e', spy.sequelize);
        assert.strictEqual(spy.queryCount, 2);
    });
});

// ── flush() integration ────────────────────────────────────────────────────

describe('flush integration — invalidates touched sessions on success only', () => {
    test('successful flush invalidates every touched session', async () => {
        const spy = makeSequelizeSpy({
            'flush-ok-a': ['k5', 'kc'],
            'flush-ok-b': ['kd'],
        });

        // Prime both sessions so entries exist BEFORE the flush writes rows.
        await discoverPidKeys('flush-ok-a', spy.sequelize);
        await discoverPidKeys('flush-ok-b', spy.sequelize);
        assert.strictEqual(spy.queryCount, 2);

        let bulkCreateCalls = [];
        const { ingestBuffer, restore } = loadFreshIngestBuffer(
            makeMockModels({ bulkCreate: async (rows) => { bulkCreateCalls.push(rows); return rows; } })
        );
        try {
            ingestBuffer.ingest({ userId: 1, sessionId: 'flush-ok-a', time: new Date(), lon: 0, lat: 0, values: { k5: 90 }, engineRpm: null, vehicleSpeed: null });
            ingestBuffer.ingest({ userId: 1, sessionId: 'flush-ok-b', time: new Date(), lon: 0, lat: 0, values: {}, engineRpm: null, vehicleSpeed: null });
            ingestBuffer.ingest({ userId: 1, sessionId: 'flush-ok-a', time: new Date(), lon: 0, lat: 0, values: { kc: 1500 }, engineRpm: null, vehicleSpeed: null });

            await ingestBuffer.flush();

            assert.strictEqual(bulkCreateCalls.length >= 1, true, 'bulkCreate ran');

            // Both touched sessions must be invalidated → one requery each.
            await discoverPidKeys('flush-ok-a', spy.sequelize);
            await discoverPidKeys('flush-ok-b', spy.sequelize);
            assert.strictEqual(spy.queryCount, 4,
                'both touched sessions invalidated (2 priming + 2 post-flush queries)');
        } finally {
            restore();
        }
    });

    test('failed flush does NOT invalidate — cache survives', async () => {
        const spy = makeSequelizeSpy({
            'flush-fail-c': ['kff1238', 'kc'],
        });

        await discoverPidKeys('flush-fail-c', spy.sequelize);
        assert.strictEqual(spy.queryCount, 1);

        const { ingestBuffer, restore } = loadFreshIngestBuffer(
            makeMockModels({ bulkCreate: async () => { throw new Error('db down'); } })
        );
        try {
            ingestBuffer.ingest({ userId: 1, sessionId: 'flush-fail-c', time: new Date(), lon: 0, lat: 0, values: { kc: 800 }, engineRpm: null, vehicleSpeed: null });

            // flush() must resolve despite the write failure (errors are caught
            // internally and the batch is requeued).
            await ingestBuffer.flush();

            // Nothing was written → cached key-set must still be valid.
            const keys = await discoverPidKeys('flush-fail-c', spy.sequelize);
            assert.strictEqual(spy.queryCount, 1, 'failed flush must not drop the cache entry');
            assert.deepStrictEqual(keys, ['kc', 'kff1238']);
        } finally {
            restore();
        }
    });
});

// ── recomputeSummary invalidation (Plan 011) ───────────────────────────────
// cut/filter/copy/join mutate Logs outside ingestBuffer.flush(), so the PID
// key-set cache must be dropped by recomputeSummary — including when the
// mutation removed EVERY row (the case where the cached keys are most wrong).
// The invalidation sits before the `if (!log) return;` early exit.

function loadControllerWithMocks(logRow) {
    const modelsPath = require.resolve('../models');
    const originalModelsCache = require.cache[modelsPath];
    require.cache[modelsPath] = {
        id: modelsPath,
        filename: modelsPath,
        loaded: true,
        exports: {
            Session: { update: async () => [1] },
            Log: { findOne: async () => logRow },
            sequelize: { fn: () => null, col: () => null, query: async () => [] },
            Sequelize: { Op: { and: Symbol('and'), gt: Symbol('gt'), lte: Symbol('lte') } },
        },
    };

    const scPath = require.resolve('../controllers/SessionController');
    const originalSCCache = require.cache[scPath];
    delete require.cache[scPath];

    return {
        recomputeSummary: require('../controllers/SessionController').recomputeSummary,
        restore() {
            if (originalModelsCache) {
                require.cache[modelsPath] = originalModelsCache;
            } else {
                delete require.cache[modelsPath];
            }
            if (originalSCCache) {
                require.cache[scPath] = originalSCCache;
            } else {
                delete require.cache[scPath];
            }
        },
    };
}

describe('recomputeSummary — invalidates pid cache for Log mutations', () => {
    test('all-null aggregate row (every log removed) still invalidates', async () => {
        const spy = makeSequelizeSpy({ 'summary-null-agg': ['k5', 'kc'] });

        await discoverPidKeys('summary-null-agg', spy.sequelize);
        assert.strictEqual(spy.queryCount, 1);

        const { recomputeSummary, restore } = loadControllerWithMocks({
            start: null, end: null, maxSpeed: null, maxRpm: null,
        });
        try {
            await recomputeSummary('summary-null-agg');
        } finally {
            restore();
        }

        const keys = await discoverPidKeys('summary-null-agg', spy.sequelize);
        assert.strictEqual(spy.queryCount, 2, 'cache dropped even though the aggregate is all NULL');
        assert.deepStrictEqual(keys, ['k5', 'kc']);
    });

    test('missing aggregate row (Log.findOne null, early return) still invalidates', async () => {
        const spy = makeSequelizeSpy({ 'summary-no-row': ['kd'] });

        await discoverPidKeys('summary-no-row', spy.sequelize);
        assert.strictEqual(spy.queryCount, 1);

        // Log.findOne resolves null → recomputeSummary returns before
        // Session.update; invalidation must still have happened.
        const { recomputeSummary, restore } = loadControllerWithMocks(null);
        try {
            await recomputeSummary('summary-no-row');
        } finally {
            restore();
        }

        const keys = await discoverPidKeys('summary-no-row', spy.sequelize);
        assert.strictEqual(spy.queryCount, 2, 'early-return path must invalidate before returning');
        assert.deepStrictEqual(keys, ['kd']);
    });

    test('ordinary recompute (logs remain) also invalidates', async () => {
        const spy = makeSequelizeSpy({ 'summary-normal': ['kb', 'kf'] });

        await discoverPidKeys('summary-normal', spy.sequelize);
        assert.strictEqual(spy.queryCount, 1);

        const { recomputeSummary, restore } = loadControllerWithMocks({
            start: '2026-01-01T00:00:00Z',
            end: '2026-01-01T01:00:00Z',
            maxSpeed: 0,
            maxRpm: 0,
        });
        try {
            await recomputeSummary('summary-normal');
        } finally {
            restore();
        }

        await discoverPidKeys('summary-normal', spy.sequelize);
        assert.strictEqual(spy.queryCount, 2);
    });
});
