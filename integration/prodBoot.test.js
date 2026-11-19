'use strict';

// Production boot contract. The image's CMD is `migrate.js && app.js`: no
// sequelize.sync(). A real TimescaleDB is reset to an empty schema and only
// `node scripts/migrate.js` is run, which must produce the schema the models
// use — including the migration-shaped `Sessions.userId … ON DELETE CASCADE`
// foreign key (the sync shape is `SET NULL`). The pre-#83 Settings trap is
// covered too: an old 3-column Settings table plus a re-run of 002 must not
// abort the boot, and 025 must backfill the timestamps.
//
// This suite resets the target database itself, so it does not depend on
// boot.test.js or ingest.test.js having run first. Missing env or an
// unreachable database SKIPS locally (so `npm run verify` stays DB-free) but
// FAILS in CI (`CI=true`): a green integration job without a database would be
// a false pass.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const CI = process.env.CI === 'true';

// Dropped together; CASCADE also removes the continuous aggregate and the
// hypertable metadata that depend on Logs.
const APP_TABLES = ['Logs', 'Sessions', 'Users', 'Analyses', 'Vehicles', 'Settings'];

function migrate() {
    return execFileSync(process.execPath, ['scripts/migrate.js'], {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
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

// TRUNCATE/DROP is destructive: demand the same opt-in as ingest.test.js.
function assertDisposable() {
    if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_RESET_DB !== '1') {
        assert.fail(
            'prodBoot.test.js drops app tables: set NODE_ENV=test or INTEGRATION_RESET_DB=1 ' +
            'to confirm this is a disposable database'
        );
    }
}

test('a fresh database boots from migrate.js alone, with the migrations FK shape', async (t) => {
    const reason = skipReason();
    if (reason) return unavailable(t, reason);
    if (!(await reachable())) return unavailable(t, 'database unreachable');
    assertDisposable();

    await withClient((client) => {
        const list = APP_TABLES.map((name) => `"${name}"`).join(', ');
        return client.query(`DROP TABLE IF EXISTS ${list}, "_migrations" CASCADE`);
    });

    const out = migrate();
    assert.match(out, /\[migrate\] Done\./, `migrate did not finish:\n${out}`);

    const state = await withClient(async (client) => {
        const fk = await client.query(
            `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
              WHERE conname = 'Sessions_userId_fkey'`
        );
        const settings = await client.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'Settings'
                AND column_name = 'createdAt'`
        );
        const pkey = await client.query(
            `SELECT 1 FROM pg_constraint WHERE conname = 'Logs_pkey'`
        );
        const hypertables = await client.query(
            `SELECT hypertable_name FROM timescaledb_information.hypertables
              WHERE hypertable_name = 'Logs'`
        );
        return {
            fk: fk.rows[0] && fk.rows[0].def,
            createdAt: settings.rowCount,
            logsPkey: pkey.rowCount,
            hypertables: hypertables.rowCount,
        };
    });

    assert.ok(state.fk, 'Sessions_userId_fkey must exist');
    assert.match(state.fk, /ON DELETE CASCADE/, `expected ON DELETE CASCADE, got: ${state.fk}`);
    assert.strictEqual(state.createdAt, 1, 'Settings."createdAt" must exist');
    assert.strictEqual(state.logsPkey, 1, 'Logs_pkey must exist');
    assert.strictEqual(state.hypertables, 1, 'Logs must be a hypertable');

    const second = migrate();
    assert.match(second, /\[migrate\] Done\./, `second migrate did not finish:\n${second}`);
    assert.match(second, /\[migrate\] SKIP \(already applied\)/, 'second boot must be a no-op');
});

test('an old (pre-#83) Settings table is repaired by 002 + 025, not a boot failure', async (t) => {
    const reason = skipReason();
    if (reason) return unavailable(t, reason);
    if (!(await reachable())) return unavailable(t, 'database unreachable');
    assertDisposable();

    // Simulate a database that applied the old 002 and has no tracker rows:
    // Settings without timestamps, everything else already migrated.
    await withClient((client) => client.query(
        `DROP TABLE IF EXISTS "Settings", "_migrations" CASCADE;
         CREATE TABLE "Settings" (
             id integer PRIMARY KEY,
             "disableRegistration" boolean NOT NULL DEFAULT false,
             "uploadApiToken" text
         );`
    ));

    const out = migrate();
    assert.match(out, /\[migrate\] Done\./, `migrate aborted on the old Settings shape:\n${out}`);

    const state = await withClient(async (client) => {
        const columns = await client.query(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'Settings'
                AND column_name = ANY($1)`,
            [['createdAt', 'updatedAt']]
        );
        const seed = await client.query('SELECT count(*)::int AS n FROM "Settings" WHERE id = 1');
        return { columns: columns.rows.map((r) => r.column_name).sort(), seed: seed.rows[0].n };
    });

    assert.deepStrictEqual(state.columns, ['createdAt', 'updatedAt'], '025 must backfill both timestamps');
    assert.strictEqual(state.seed, 1, '002 must seed the singleton row');
});
