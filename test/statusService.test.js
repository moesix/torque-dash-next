'use strict';

// Plan 019 — in-process status collectors. These are unit-scoped: the
// sequelize handle and the three collaborator modules are injected, so no DB
// or model is touched.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { collectStatus } = require('../services/status');

const packageVersion = require('../package.json').version;

function makeDeps(overrides = {}) {
    return {
        Settings: {
            getSingleton: async () => ({
                retentionEnabled: true,
                retentionDays: 30,
                uploadApiToken: 'must-never-appear',
                llmApiKeyEnc: 'must-never-appear',
            }),
            ...overrides.Settings,
        },
        ingestBuffer: {
            size: () => 42,
            isFlushing: () => true,
            ...overrides.ingestBuffer,
        },
        analysesRetention: {
            getLastRun: () => ({
                at: '2026-11-19T10:00:00.000Z',
                pruned: 7,
                enabled: true,
            }),
            ...overrides.analysesRetention,
        },
    };
}

function makeSequelize(overrides = {}) {
    return {
        QueryTypes: { SELECT: 'SELECT' },
        query: async (sql) => {
            if (/pg_extension/.test(sql)) return [{ extversion: '2.14.2' }];
            if (/policy_retention/.test(sql)) return [{ '?column?': 1 }];
            if (/job_stats/.test(sql)) {
                return [
                    { job_id: 1001, schedule_interval: '1 day', last_run_status: 'Success' },
                    { job_id: 1002, schedule_interval: '00:01:00', last_run_status: 'Success' },
                ];
            }
            return [];
        },
        ...overrides,
    };
}

describe('collectStatus — full shape', () => {
    test('returns version/uptime/node plus all four populated blocks', async () => {
        const status = await collectStatus(makeSequelize(), makeDeps());

        assert.strictEqual(status.version, packageVersion);
        assert.strictEqual(typeof status.uptimeSeconds, 'number');
        assert.strictEqual(status.node, process.version);

        assert.deepStrictEqual(status.ingest, { bufferSize: 42, flushing: true });
        assert.deepStrictEqual(status.analysesRetention, {
            lastRunAt: '2026-11-19T10:00:00.000Z',
            pruned: 7,
            enabled: true,
        });
        assert.deepStrictEqual(status.retention, {
            enabled: true,
            days: 30,
            policyJobPresent: true,
        });
        assert.deepStrictEqual(status.timescale, {
            extensionVersion: '2.14.2',
            jobs: [
                { jobId: 1001, scheduleInterval: '1 day', lastRunStatus: 'Success' },
                { jobId: 1002, scheduleInterval: '00:01:00', lastRunStatus: 'Success' },
            ],
        });
        for (const key of ['ingestError', 'analysesRetentionError', 'retentionError', 'timescaleError']) {
            assert.strictEqual(Object.prototype.hasOwnProperty.call(status, key), false);
        }
    });

    test('never leaks Settings secrets into the payload', async () => {
        const status = await collectStatus(makeSequelize(), makeDeps());
        const serialized = JSON.stringify(status);
        assert.ok(!serialized.includes('must-never-appear'));
        assert.strictEqual(Object.prototype.hasOwnProperty.call(status, 'uploadApiToken'), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(status, 'llmApiKeyEnc'), false);
    });
});

describe('collectStatus — per-block null safety', () => {
    test('ingest accessor throwing nulls only the ingest block', async () => {
        const status = await collectStatus(makeSequelize(), makeDeps({
            ingestBuffer: {
                size: () => { throw new Error('buffer boom'); },
                isFlushing: () => false,
            },
        }));

        assert.strictEqual(status.ingest, null);
        assert.strictEqual(status.ingestError, true);
        assert.ok(status.timescale, 'other blocks still populate');
        assert.ok(status.retention);
    });

    test('analysesRetention lookup throwing nulls only that block', async () => {
        const status = await collectStatus(makeSequelize(), makeDeps({
            analysesRetention: { getLastRun: () => { throw new Error('seam boom'); } },
        }));

        assert.strictEqual(status.analysesRetention, null);
        assert.strictEqual(status.analysesRetentionError, true);
        assert.deepStrictEqual(status.ingest, { bufferSize: 42, flushing: true });
        assert.ok(status.timescale);
    });

    test('a Settings read failure nulls only the retention block', async () => {
        const status = await collectStatus(makeSequelize(), makeDeps({
            Settings: { getSingleton: async () => { throw new Error('settings boom'); } },
        }));

        assert.strictEqual(status.retention, null);
        assert.strictEqual(status.retentionError, true);
        assert.ok(status.timescale);
        assert.ok(status.analysesRetention);
    });

    test('a Timescale probe failure nulls the timescale block', async () => {
        const status = await collectStatus(makeSequelize({
            query: async (sql) => {
                if (/pg_extension/.test(sql)) throw new Error('no timescaledb');
                if (/policy_retention/.test(sql)) return [{ '?column?': 1 }];
                return [];
            },
        }), makeDeps());

        assert.strictEqual(status.timescale, null);
        assert.strictEqual(status.timescaleError, true);
        assert.deepStrictEqual(status.retention, {
            enabled: true,
            days: 30,
            policyJobPresent: true,
        });
    });

    test('a failure in every collector still resolves (no unhandled rejection)', async () => {
        await assert.doesNotReject(async () => {
            const status = await collectStatus(makeSequelize({
                query: async () => { throw new Error('db down'); },
            }), makeDeps({
                Settings: { getSingleton: async () => { throw new Error('db down'); } },
                ingestBuffer: { size: () => { throw new Error('db down'); } },
                analysesRetention: { getLastRun: () => { throw new Error('db down'); } },
            }));

            assert.strictEqual(status.ingest, null);
            assert.strictEqual(status.analysesRetention, null);
            assert.strictEqual(status.retention, null);
            assert.strictEqual(status.timescale, null);
            assert.strictEqual(status.status, undefined, 'the controller adds status:ok');
        });
    });
});

describe('collectStatus — partial / empty state', () => {
    test('no prune pass yet is an empty block, not an error', async () => {
        const status = await collectStatus(makeSequelize(), makeDeps({
            analysesRetention: { getLastRun: () => null },
        }));

        assert.strictEqual(status.analysesRetention, null);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(status, 'analysesRetentionError'), false);
    });

    test('a failed policy-job probe keeps retention populated with a null probe', async () => {
        const status = await collectStatus(makeSequelize({
            query: async (sql) => {
                if (/policy_retention/.test(sql)) throw new Error('permission denied');
                if (/pg_extension/.test(sql)) return [{ extversion: '2.14.2' }];
                return [];
            },
        }), makeDeps());

        assert.deepStrictEqual(status.retention, {
            enabled: true,
            days: 30,
            policyJobPresent: null,
        });
        assert.strictEqual(Object.prototype.hasOwnProperty.call(status, 'retentionError'), false);
    });
});
