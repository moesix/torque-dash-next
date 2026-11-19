'use strict';

// Boot contract for the migrations-only stack: a real TimescaleDB starts
// empty, `node scripts/migrate.js` alone must produce the schema the models
// use (no sequelize.sync() anywhere), and a second run must be a no-op.
//
// Missing env or an unreachable database SKIPS locally (so `npm run verify`
// stays DB-free) but FAILS in CI (`CI=true`): a green integration job without
// a database would be a false pass.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const CI = process.env.CI === 'true';
const APP_TABLES = ['Users', 'Sessions', 'Logs', 'Vehicles', 'Analyses', 'Settings'];

test('the Docker CMD boots migrations-only (no sequelize.sync)', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const cmdLines = dockerfile
        .split('\n')
        .filter((line) => /^\s*CMD\b/.test(line));
    assert.strictEqual(cmdLines.length, 1, 'Dockerfile must declare exactly one CMD');
    const cmd = cmdLines[0];
    assert.ok(!/sequelize\.sync/.test(cmd), `CMD must not sync:\n${cmd}`);
    assert.match(cmd, /node scripts\/migrate\.js && node app\.js/, `CMD must migrate then start:\n${cmd}`);
});

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

test('migrate.js alone boots a fresh database, twice, idempotently', async (t) => {
    const reason = skipReason();
    if (reason) return unavailable(t, reason);
    if (!(await reachable())) return unavailable(t, 'database unreachable');

    const first = migrate();
    assert.match(first, /\[migrate\] Done\./, `first migrate did not finish:\n${first}`);

    const schema = await withClient(async (client) => {
        const tables = await client.query(
            `SELECT table_name FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name = ANY($1)`,
            [APP_TABLES]
        );
        const hypertables = await client.query(
            `SELECT hypertable_name FROM timescaledb_information.hypertables
              WHERE hypertable_name = 'Logs'`
        );
        const tracker = await client.query('SELECT count(*)::int AS n FROM _migrations');
        const caggs = await client.query(
            `SELECT view_name FROM timescaledb_information.continuous_aggregates
              WHERE view_name = 'log_1min'`
        );
        const caggJobs = await client.query(
            `SELECT job_id FROM timescaledb_information.jobs
              WHERE proc_name = 'policy_refresh_continuous_aggregate'
                AND hypertable_name = 'log_1min'`
        );
        const legacyView = await client.query(
            "SELECT to_regclass('public.log_1min') AS oid"
        );
        return {
            tables: tables.rows.map((r) => r.table_name).sort(),
            hypertables: hypertables.rowCount,
            migrations: tracker.rows[0].n,
            caggs: caggs.rowCount,
            caggJobs: caggJobs.rowCount,
            legacyView: legacyView.rows[0].oid,
        };
    });

    assert.deepStrictEqual(schema.tables, [...APP_TABLES].sort(), 'migrations must create every app table');
    assert.strictEqual(schema.hypertables, 1, 'Logs must be a TimescaleDB hypertable');
    assert.strictEqual(schema.caggs, 0, '029 must retire the unused log_1min continuous aggregate');
    assert.strictEqual(schema.caggJobs, 0, '029 must remove the log_1min refresh policy job');
    assert.strictEqual(schema.legacyView, null, 'no log_1min relation may survive the migration series');
    assert.ok(schema.migrations > 0, '_migrations must record applied files');

    const second = migrate();
    assert.match(second, /\[migrate\] Done\./, `second migrate did not finish:\n${second}`);
    assert.match(second, /\[migrate\] SKIP \(already applied\)/, 'second run must skip recorded files');

    const after = await withClient((client) =>
        client.query('SELECT count(*)::int AS n FROM _migrations')
    );
    assert.strictEqual(after.rows[0].n, schema.migrations, 're-run must not duplicate tracker rows');
});
