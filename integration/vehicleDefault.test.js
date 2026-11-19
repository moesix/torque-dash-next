'use strict';

// Plan 033: "default vehicle" must be a real invariant. Two things are
// verified against a real migrations-only Postgres:
//
//   1. migration 027 dedupes existing duplicate defaults (lowest id wins)
//      before creating the partial unique index, and the index then rejects a
//      second default at the database level;
//   2. two concurrent setDefault calls leave exactly one default for the user.
//
// Env is pinned before the app modules load. Missing env or an unreachable DB
// SKIPS locally (so `npm run verify` stays DB-free) but FAILS in CI.
//
// This suite owns the target database: it truncates app tables at the start.
// That destructive reset is guarded exactly like the ingest suite.

process.env.UPLOAD_API_TOKEN = process.env.UPLOAD_API_TOKEN || 'integration-upload-token';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const CI = process.env.CI === 'true';

let models;
let sequelize;
let User;
let Vehicle;
let VehicleController;
let client;
let loadError = null;

try {
    models = require('../models');
    sequelize = models.sequelize;
    User = models.User;
    Vehicle = models.Vehicle;
    VehicleController = require('../controllers/VehicleController');
} catch (err) {
    loadError = err;
}

const state = { skip: null };

function missingEnvReason() {
    if (!process.env.DATABASE_URL) return 'DATABASE_URL not set — no database to test against';
    if (!process.env.SESSION_KEYS) return 'SESSION_KEYS not set — models cannot load config';
    return null;
}

function unavailable(reason) {
    if (CI) assert.fail(`CI requires a reachable integration database: ${reason}`);
    state.skip = reason;
}

function migrate() {
    return execFileSync(process.execPath, ['scripts/migrate.js'], {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

async function reachable() {
    const probe = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 2000,
    });
    try {
        await probe.connect();
        await probe.query('SELECT 1');
        return true;
    } catch {
        return false;
    } finally {
        await probe.end().catch(() => {});
    }
}

async function resetDatabase() {
    if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_RESET_DB !== '1') {
        throw new Error(
            'resetDatabase() refuses to TRUNCATE: set NODE_ENV=test or INTEGRATION_RESET_DB=1 ' +
            'to confirm this is a disposable database'
        );
    }
    await sequelize.query(
        'TRUNCATE TABLE "Logs", "Sessions", "Analyses", "Vehicles", "Users", "Settings" CASCADE'
    );
    await sequelize.query(
        'INSERT INTO "Settings" (id, "disableRegistration", "uploadApiToken") ' +
        'VALUES (1, false, NULL) ON CONFLICT (id) DO NOTHING'
    );
}

// The 027 file is already applied (and tracked) by the time this runs, so a
// second `migrate.js` is a no-op. Execute the file's statements directly to
// prove the dedupe + index DDL itself, on rows the old code could have left
// behind.
function migrationStatements() {
    const file = path.join(ROOT, 'infra', 'timescale', '027_vehicle_default_unique.sql');
    const sql = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/--[^\n]*/g, '');
    return sql.split(';').map((s) => s.trim()).filter(Boolean);
}

function makeRes() {
    const calls = { statusCode: null, body: null };
    const res = {
        status(code) { calls.statusCode = code; return res; },
        json(obj) { calls.body = obj; return res; },
    };
    return { res, calls };
}

let userSeq = 0;
async function makeUser() {
    return User.create({
        email: `vehicle-default-${Date.now()}-${userSeq++}@example.com`,
        password: 'integration-pass-1',
        isAdmin: false,
    });
}

before(async () => {
    const envReason = missingEnvReason();
    if (envReason) return unavailable(envReason);
    if (loadError) return unavailable(`models not loadable: ${loadError.message.split('\n')[0]}`);
    if (!(await reachable())) return unavailable('database unreachable');

    const migrated = migrate();
    assert.match(migrated, /\[migrate\] Done\./, `migrate did not finish:\n${migrated}`);

    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await resetDatabase();
});

after(async () => {
    if (client) await client.end().catch(() => {});
    if (sequelize) await sequelize.close().catch(() => {});
});

test('027 dedupes to the lowest-id default, then the partial index rejects a second', async (t) => {
    if (state.skip) return t.skip(state.skip);

    await client.query('DROP INDEX IF EXISTS "Vehicles_one_default_per_user"');
    const user = await makeUser();
    const first = await Vehicle.create({ name: 'First', userId: user.id, isDefault: true });
    const second = await Vehicle.create({ name: 'Second', userId: user.id, isDefault: true });

    for (const statement of migrationStatements()) {
        await client.query(statement);
    }

    const defaults = await client.query(
        'SELECT id FROM "Vehicles" WHERE "userId" = $1 AND "isDefault" = true ORDER BY id',
        [user.id]
    );
    assert.deepStrictEqual(
        defaults.rows.map((r) => r.id),
        [first.id],
        'dedupe must keep exactly the lowest-id default'
    );

    const index = await client.query(
        `SELECT 1 FROM pg_indexes WHERE tablename = 'Vehicles' AND indexname = 'Vehicles_one_default_per_user'`
    );
    assert.strictEqual(index.rowCount, 1, 'Vehicles_one_default_per_user must exist');

    // The index is partial on isDefault = true: promoting the second row while
    // the first is default must be rejected by the database itself.
    await assert.rejects(
        client.query('UPDATE "Vehicles" SET "isDefault" = true WHERE id = $1', [second.id]),
        (err) => err.code === '23505',
        'a second default must raise a unique violation'
    );
});

test('two concurrent setDefault calls leave exactly one default', async (t) => {
    if (state.skip) return t.skip(state.skip);

    const user = await makeUser();
    const a = await Vehicle.create({ name: 'A', userId: user.id, isDefault: false });
    const b = await Vehicle.create({ name: 'B', userId: user.id, isDefault: false });

    const one = makeRes();
    const two = makeRes();
    await Promise.all([
        VehicleController.setDefault({ user: { id: user.id }, params: { vehicleId: String(a.id) } }, one.res),
        VehicleController.setDefault({ user: { id: user.id }, params: { vehicleId: String(b.id) } }, two.res),
    ]);

    const defaults = await client.query(
        'SELECT id FROM "Vehicles" WHERE "userId" = $1 AND "isDefault" = true',
        [user.id]
    );
    assert.strictEqual(defaults.rowCount, 1, 'exactly one default must remain');
    assert.ok(
        [a.id, b.id].includes(defaults.rows[0].id),
        'the surviving default must be one of the two requested vehicles'
    );
    assert.ok(
        [one.calls.statusCode, two.calls.statusCode].includes(null),
        'at least one request must succeed without an error status'
    );
});
