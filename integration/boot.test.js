'use strict';

// Boot contract for the migrations-only stack: a real TimescaleDB starts
// empty, `node scripts/migrate.js` alone must produce the schema the models
// use (no sequelize.sync() anywhere), and a second run must be a no-op.
// Skips (rather than fails) when no database is reachable — `npm run verify`
// stays DB-free.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const APP_TABLES = ['Users', 'Sessions', 'Logs', 'Vehicles', 'Analyses', 'Settings'];

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

test('migrate.js alone boots a fresh database, twice, idempotently', async (t) => {
    const reason = skipReason();
    if (reason) return t.skip(reason);
    if (!(await reachable())) return t.skip('database unreachable');

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
        return {
            tables: tables.rows.map((r) => r.table_name).sort(),
            hypertables: hypertables.rowCount,
            migrations: tracker.rows[0].n,
        };
    });

    assert.deepStrictEqual(schema.tables, [...APP_TABLES].sort(), 'migrations must create every app table');
    assert.strictEqual(schema.hypertables, 1, 'Logs must be a TimescaleDB hypertable');
    assert.ok(schema.migrations > 0, '_migrations must record applied files');

    const second = migrate();
    assert.match(second, /\[migrate\] Done\./, `second migrate did not finish:\n${second}`);
    assert.match(second, /\[migrate\] SKIP \(already applied\)/, 'second run must skip recorded files');

    const after = await withClient((client) =>
        client.query('SELECT count(*)::int AS n FROM _migrations')
    );
    assert.strictEqual(after.rows[0].n, schema.migrations, 're-run must not duplicate tracker rows');
});
