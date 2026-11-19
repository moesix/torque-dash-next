'use strict';

// Plan 046 — production upgrade failure reproduced as a test.
//
// A deployment whose `Settings` table was created by `sequelize.sync()` has both
// timestamp columns declared NOT NULL **without a database default** (values are
// supplied by the model). The pre-046 `002_settings.sql` seed omitted those
// columns, so the v2.3.2 -> v2.4.0 upgrade aborted the whole run with:
//
//   [002_settings.sql] FAILED: null value in column "createdAt" of relation
//   "Settings" violates not-null constraint
//
// and the container restart-looped. This suite reproduces that exact shape:
// sync-style Settings (no defaults, no row) + no migration tracker, then runs
// migrate.js and requires a clean boot with a seeded, timestamped singleton.
//
// Missing env or an unreachable database SKIPS locally (so `npm run verify`
// stays DB-free) but FAILS in CI (`CI=true`): a green integration job without a
// database would be a false pass.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const CI = process.env.CI === 'true';

function migrate() {
    try {
        return execFileSync(process.execPath, ['scripts/migrate.js'], {
            cwd: ROOT,
            env: process.env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (err) {
        const stderr = err.stderr ? String(err.stderr).trim() : '';
        throw new Error(
            `migrate.js exited ${err.status}:\n${stderr || err.message}`,
            { cause: err }
        );
    }
}

async function withClient(fn) {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 2000,
    });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end();
    }
}

async function reachable() {
    try {
        await withClient((client) => client.query('SELECT 1'));
        return true;
    } catch {
        return false;
    }
}

function skipReason() {
    if (!process.env.DATABASE_URL) return 'DATABASE_URL not set — no database to boot';
    if (!process.env.SESSION_KEYS) return 'SESSION_KEYS not set — migrate.js cannot load config';
    return null;
}

// CI has no legitimate reason to be without a database: fail instead of skip.
function unavailable(t, reason) {
    if (CI) assert.fail(`CI requires a bootable database: ${reason}`);
    return t.skip(reason);
}

// DROP is destructive: demand the same opt-in as the other reset suites.
function assertDisposable() {
    if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_RESET_DB !== '1') {
        assert.fail(
            'settingsUpgrade.test.js drops app tables: set NODE_ENV=test or ' +
            'INTEGRATION_RESET_DB=1 to confirm this is a disposable database'
        );
    }
}

test('a sequelize.sync-shaped Settings table (no defaults) upgrades cleanly', async (t) => {
    const reason = skipReason();
    if (reason) return unavailable(t, reason);
    if (!(await reachable())) return unavailable(t, 'database unreachable');
    assertDisposable();

    // Reproduce production: Settings came from sync() — timestamps NOT NULL
    // with no DB default — and the tracker was never written (no row either,
    // like a deployment that restarted before the first toggle).
    await withClient((client) => client.query(
        `DROP TABLE IF EXISTS "Settings", "_migrations" CASCADE;
         CREATE TABLE "Settings" (
             id integer PRIMARY KEY,
             "disableRegistration" boolean NOT NULL DEFAULT false,
             "uploadApiToken" text,
             "createdAt" TIMESTAMPTZ NOT NULL,
             "updatedAt" TIMESTAMPTZ NOT NULL
         );`
    ));

    const before = await withClient((client) =>
        client.query(
            `SELECT column_name, column_default FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'Settings'
                AND column_name = ANY($1)
              ORDER BY column_name`,
            [['createdAt', 'updatedAt']]
        )
    );
    assert.deepStrictEqual(
        before.rows.map((r) => [r.column_name, r.column_default]),
        [['createdAt', null], ['updatedAt', null]],
        'precondition: sync() leaves both timestamps NOT NULL with no default'
    );

    const out = migrate();
    assert.match(out, /\[migrate\] Done\./, `migrate aborted on the sync-shaped Settings table:\n${out}`);

    const state = await withClient(async (client) => {
        const row = await client.query(
            `SELECT id,
                    "createdAt" IS NOT NULL AS created_ok,
                    "updatedAt" IS NOT NULL AS updated_ok
               FROM "Settings" WHERE id = 1`
        );
        const defaults = await client.query(
            `SELECT column_name, column_default FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'Settings'
                AND column_name = ANY($1)
              ORDER BY column_name`,
            [['createdAt', 'updatedAt']]
        );
        const tracked = await client.query(
            `SELECT filename FROM _migrations
              WHERE filename IN ('002_settings.sql', '025_settings_timestamps.sql')
              ORDER BY filename`
        );
        return {
            row: row.rows[0],
            defaults: defaults.rows.map((r) => [r.column_name, r.column_default]),
            tracked: tracked.rows.map((r) => r.filename),
        };
    });

    assert.ok(state.row, '002 must seed the singleton row');
    assert.strictEqual(state.row.id, 1);
    assert.strictEqual(state.row.created_ok, true, 'seeded "createdAt" must be non-null');
    assert.strictEqual(state.row.updated_ok, true, 'seeded "updatedAt" must be non-null');
    assert.deepStrictEqual(
        state.defaults,
        [['createdAt', 'now()'], ['updatedAt', 'now()']],
        '030 must give both timestamps a DB default'
    );
    assert.deepStrictEqual(
        state.tracked,
        ['002_settings.sql', '025_settings_timestamps.sql'],
        'both 002 and 025 (a no-op here — columns already existed) must be recorded'
    );

    // Idempotent: a second boot must be a no-op and must not touch the row.
    const second = migrate();
    assert.match(second, /\[migrate\] Done\./, `second migrate did not finish:\n${second}`);
    assert.match(second, /\[migrate\] SKIP \(already applied\)/, 'second boot must be a no-op');

    const after = await withClient((client) =>
        client.query('SELECT count(*)::int AS n FROM "Settings"')
    );
    assert.strictEqual(after.rows[0].n, 1, 'the singleton row must not be duplicated');
});
