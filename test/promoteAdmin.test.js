'use strict';

// Admin recovery-path tests for scripts/promote-admin.js (fix for migration
// 017's lowest-id backfill — see docs/deployment.md "Admin account on
// upgrade"). Tests the exported promoteAdmin(pool, email, promote) helper
// against a mocked pg pool, mirroring how scripts/migrate.js exports its
// logic for test/migrate.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { promoteAdmin } = require('../scripts/promote-admin');

// Mocks a pg Pool's query(): records the SQL + params it was given and
// answers with either a single matching row or an empty result set.
function makeMockPool({ row }) {
    const calls = [];
    const pool = {
        query: async (sql, params) => {
            calls.push({ sql, params });
            return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
        },
    };
    return { pool, calls };
}

test('promoteAdmin sets isAdmin=true for a matching email and returns id + email', async () => {
    const { pool, calls } = makeMockPool({ row: { id: 7, email: 'ops@example.com' } });
    const result = await promoteAdmin(pool, 'OPS@Example.COM', true);

    assert.deepStrictEqual(result, { id: 7, email: 'ops@example.com' });
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].sql, /UPDATE "Users" SET "isAdmin" = \$1/);
    // Email is normalized to lowercase before the lookup and the flag is a
    // boolean true — the same identity boundary migration 015 folds.
    assert.deepStrictEqual(calls[0].params, [true, 'ops@example.com']);
});

test('promoteAdmin demote sets isAdmin=false', async () => {
    const { pool, calls } = makeMockPool({ row: { id: 7, email: 'ops@example.com' } });
    const result = await promoteAdmin(pool, 'ops@example.com', false);

    assert.deepStrictEqual(result, { id: 7, email: 'ops@example.com' });
    assert.deepStrictEqual(calls[0].params, [false, 'ops@example.com']);
});

test('promoteAdmin returns null when no user matches (script exits non-zero)', async () => {
    const { pool } = makeMockPool({ row: null });
    const result = await promoteAdmin(pool, 'ghost@example.com', true);
    assert.strictEqual(result, null);
});

test('promoteAdmin trims surrounding whitespace from the email argument', async () => {
    const { pool, calls } = makeMockPool({ row: { id: 3, email: 'a@b.com' } });
    await promoteAdmin(pool, '  a@b.com  ', true);
    assert.strictEqual(calls[0].params[1], 'a@b.com');
});
