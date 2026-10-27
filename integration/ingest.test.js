'use strict';

// End-to-end ingest suite against a real migrations-only TimescaleDB.
// Everything goes through the real HTTP surface (in-process server + fetch):
// settings → register → login → GET /api/upload → ingestBuffer.drain() →
// sessions → telemetry → CSV → rename → delete (FK cascade) → re-upload.
//
// Env is pinned before the app is required (config.js throws without
// DATABASE_URL / SESSION_KEYS); when either is missing or the database is
// unreachable every test skips locally, so `npm run verify` stays DB-free.
// In CI (`CI=true`) those same conditions FAIL — a green job without a
// database would be a false pass.
//
// This suite OWNS the target database: before() runs the idempotent migrations
// itself (no dependency on the boot suite's ordering) and resetDatabase()
// TRUNCATEs the app tables between tests. That destructive reset is guarded —
// it refuses to run unless NODE_ENV=test or INTEGRATION_RESET_DB=1.

process.env.UPLOAD_API_TOKEN = process.env.UPLOAD_API_TOKEN || 'integration-upload-token';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { Client } = require('pg');
const { makeFrame, makeSeries } = require('./fixtures/torqueFrames');

const ROOT = path.join(__dirname, '..');
const CI = process.env.CI === 'true';
const UPLOAD_TOKEN = process.env.UPLOAD_API_TOKEN;

let app;
let models;
let sequelize;
let ingestBuffer;
let runtime;
let Settings;
let Log;
let Session;
let loadError = null;

try {
    app = require('../app');
    models = require('../models');
    sequelize = models.sequelize;
    ingestBuffer = require('../services/ingestBuffer');
    runtime = require('../config/runtime');
    Settings = models.Settings;
    Log = models.Log;
    Session = models.Session;
} catch (err) {
    loadError = err;
}

const state = { skip: null, server: null, base: null };

// "host:port/db" — enough to recognise a database, without the password.
function resetTarget() {
    try {
        const url = new URL(process.env.DATABASE_URL);
        const db = url.pathname.replace(/^\//, '') || '(default)';
        return `${url.hostname}${url.port ? `:${url.port}` : ''}/${db}`;
    } catch {
        return '(unparseable DATABASE_URL)';
    }
}

function missingEnvReason() {
    if (!process.env.DATABASE_URL) return 'DATABASE_URL not set — no database to ingest into';
    if (!process.env.SESSION_KEYS) return 'SESSION_KEYS not set — app.js cannot load config';
    return null;
}

// CI must not pass without a database; local runs skip so verify stays DB-free.
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

async function databaseReachable() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 2000,
    });
    try {
        await client.connect();
        await client.query('SELECT 1');
        return true;
    } catch {
        return false;
    } finally {
        await client.end().catch(() => {});
    }
}

before(async () => {
    const envReason = missingEnvReason();
    if (envReason) return unavailable(envReason);
    if (loadError) {
        return unavailable(`app not loadable: ${loadError.message.split('\n')[0]}`);
    }
    if (!(await databaseReachable())) return unavailable('database unreachable');

    // Self-sufficient boot: this suite migrates the target itself instead of
    // relying on the boot suite having run first (idempotent — a no-op when the
    // schema is already there). Also keeps `node --test integration/ingest.test.js`
    // meaningful on its own.
    const migrated = migrate();
    assert.match(migrated, /\[migrate\] Done\./, `ingest migrate did not finish:\n${migrated}`);

    // app.js's bootstrap() seeds the runtime token holder at boot; importing
    // the module by design does not, so do the one call it would have made.
    await runtime.initUploadApiToken(models);
    state.server = http.createServer(app);
    await new Promise((resolve) => state.server.listen(0, '127.0.0.1', resolve));
    state.base = `http://127.0.0.1:${state.server.address().port}`;
});

after(async () => {
    if (state.server) await new Promise((resolve) => state.server.close(resolve));
    if (sequelize) await sequelize.close();
});

// Settings is a singleton seeded by migration 002. The tracker skips that file
// on later runs, so a truncate has to restore row id=1 itself.
//
// TRUNCATE is destructive: point DATABASE_URL at a disposable database. The
// opt-in mirrors the usual "do not wipe a database by accident" convention —
// NODE_ENV=test (CI, docker-compose.dev, local test env) or an explicit
// INTEGRATION_RESET_DB=1. The error names host/db only, never the password.
async function resetDatabase() {
    if (process.env.NODE_ENV !== 'test' && process.env.INTEGRATION_RESET_DB !== '1') {
        throw new Error(
            `resetDatabase() refuses to TRUNCATE ${resetTarget()}: ` +
            'set NODE_ENV=test or INTEGRATION_RESET_DB=1 to confirm this is a disposable database'
        );
    }
    await sequelize.query(
        'TRUNCATE TABLE "Logs", "Sessions", "Analyses", "Vehicles", "Users", "Settings" CASCADE'
    );
    await sequelize.query(
        'INSERT INTO "Settings" (id, "disableRegistration", "uploadApiToken") ' +
        'VALUES (1, false, NULL) ON CONFLICT (id) DO NOTHING'
    );
    Settings.invalidateCache();
}

async function request(pathname, { method = 'GET', cookie, body, headers = {} } = {}) {
    return fetch(`${state.base}${pathname}`, {
        method,
        redirect: 'manual',
        headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

function sessionCookie(res) {
    const cookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    const cookie = cookies.find((c) => c.startsWith('connect.sid='));
    assert.ok(cookie, 'login must set a connect.sid cookie');
    return cookie.split(';')[0];
}

let userSeq = 0;
async function registerAndLogin() {
    const email = `driver-${Date.now()}-${userSeq++}@example.com`;
    const res = await request('/api/users/register', {
        method: 'POST',
        body: { email, password: 'integration-pass-1' },
    });
    assert.strictEqual(res.status, 201, `register failed: ${await res.text()}`);

    const login = await request('/api/users/login', {
        method: 'POST',
        body: { email, password: 'integration-pass-1' },
    });
    assert.strictEqual(login.status, 200, `login failed: ${await login.text()}`);
    return { email, cookie: sessionCookie(login) };
}

// GET /api/upload is the real Torque route; the bearer token is the
// configured upload token, which also skips the upload rate limiter.
async function uploadFrame(frame) {
    const query = new URLSearchParams(frame).toString();
    return request(`/api/upload?${query}`, {
        headers: { Authorization: `Bearer ${UPLOAD_TOKEN}` },
    });
}

async function uploadSeries(frames) {
    for (const frame of frames) {
        const res = await uploadFrame(frame);
        const body = await res.text();
        assert.strictEqual(res.status, 200, `upload failed: ${body}`);
        assert.strictEqual(body, 'OK!');
    }
    await ingestBuffer.drain();
}

async function listSessions(cookie) {
    const res = await request('/api/sessions', { cookie });
    assert.strictEqual(res.status, 200);
    return res.json();
}

test('upload → drain → sessions/telemetry/CSV/rename over the real routes', async (t) => {
    if (state.skip) return t.skip(state.skip);
    await resetDatabase();

    const settings = await request('/api/settings');
    assert.strictEqual(settings.status, 200);
    assert.strictEqual((await settings.json()).disableRegistration, false);

    const { email, cookie } = await registerAndLogin();
    const sessionKey = 'it-trip-1';
    const frames = makeSeries({ session: sessionKey, eml: email, count: 5, rpmBase: 800, speedBase: 20 });
    const start = Number(frames[0].time);
    await uploadSeries(frames);

    const listed = await listSessions(cookie);
    assert.strictEqual(listed.total, 1);
    const [session] = listed.sessions;
    assert.strictEqual(session.sessionId, sessionKey);
    assert.match(session.name, /^Trip /, 'new sessions get the auto-generated Trip name');
    assert.strictEqual(session.maxRpm, 1800);
    assert.strictEqual(session.maxSpeed, 24);
    assert.strictEqual(new Date(session.startDate).getTime(), start);
    assert.strictEqual(new Date(session.endDate).getTime(), start + 4000);

    const from = new Date(start).toISOString();
    const to = new Date(start + 60_000).toISOString();
    const telemetryRes = await request(
        `/api/sessions/${session.id}/telemetry?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { cookie }
    );
    assert.strictEqual(telemetryRes.status, 200);
    const rows = await telemetryRes.json();
    assert.strictEqual(rows.length, 5);
    assert.deepStrictEqual(
        rows.map((r) => r.engine_rpm),
        [800, 1050, 1300, 1550, 1800]
    );
    assert.deepStrictEqual(rows.map((r) => r.vehicle_speed), [20, 21, 22, 23, 24]);
    assert.strictEqual(rows[0].values.kc, '800', 'raw PID keys stay in Logs.values');
    assert.strictEqual(rows[0].lat, 45.5017);
    assert.strictEqual(rows[0].lon, -73.5673);

    const csvRes = await request(`/api/sessions/${session.id}/export/csv`, { cookie });
    assert.strictEqual(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type'), /text\/csv/);
    const csvBytes = Buffer.from(await csvRes.arrayBuffer());
    assert.deepStrictEqual([...csvBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'CSV carries the Excel BOM');
    const csvText = csvBytes.toString('utf8');
    const lines = csvText.trim().split('\n');
    const header = lines[0].replace('\ufeff', '').split(',');
    for (const col of ['timestamp', 'lat', 'lon', 'engine_rpm', 'vehicle_speed', 'kc', 'kd', 'k5']) {
        assert.ok(header.includes(col), `CSV header missing ${col}`);
    }
    assert.strictEqual(lines.length, 6, 'one header row + five frame rows');
    const firstRow = lines[1].split(',');
    assert.strictEqual(firstRow[header.indexOf('engine_rpm')], '800');
    assert.strictEqual(firstRow[header.indexOf('vehicle_speed')], '20');
    assert.strictEqual(firstRow[header.indexOf('lat')], '45.5017');

    const renameRes = await request(`/api/sessions/rename/${session.id}`, {
        method: 'PATCH',
        cookie,
        body: { name: 'Integration Run' },
    });
    assert.strictEqual(renameRes.status, 200);
    const detail = await request(`/api/sessions/${session.id}`, { cookie });
    assert.strictEqual((await detail.json()).name, 'Integration Run');
});

test('delete cascades Logs and a re-upload recreates the session', async (t) => {
    if (state.skip) return t.skip(state.skip);
    await resetDatabase();

    const { email, cookie } = await registerAndLogin();
    const sessionKey = 'it-trip-2';
    await uploadSeries(makeSeries({ session: sessionKey, eml: email, count: 4 }));

    const before = await listSessions(cookie);
    assert.strictEqual(before.total, 1);
    const sessionId = before.sessions[0].id;
    assert.strictEqual(await Log.count({ where: { sessionId } }), 4);

    const del = await request(`/api/sessions/${sessionId}`, { method: 'DELETE', cookie });
    assert.strictEqual(del.status, 200);
    assert.strictEqual(await Log.count({ where: { sessionId } }), 0, 'Logs must cascade with the session');
    assert.strictEqual(await Session.count({ where: { id: sessionId } }), 0);

    // Same device session id after a delete: the upload path must re-create the
    // session (the cached FK was evicted) and accept frames without an FK storm.
    await uploadSeries(makeSeries({ session: sessionKey, eml: email, count: 3, start: Date.UTC(2026, 0, 16, 9, 0, 0) }));

    const recreated = await Session.findOne({ where: { sessionId: sessionKey } });
    assert.ok(recreated, 're-upload must recreate the session row');
    assert.notStrictEqual(recreated.id, sessionId);
    assert.strictEqual(await Log.count({ where: { sessionId: recreated.id } }), 3);

    const listed = await listSessions(cookie);
    assert.strictEqual(listed.total, 1);
    assert.strictEqual(listed.sessions[0].maxRpm, 1300, 'summaries are not inherited from the deleted session');
});

test('upload without a bearer token is rejected', async (t) => {
    if (state.skip) return t.skip(state.skip);
    const res = await request(`/api/upload?${new URLSearchParams(makeFrame({ session: 'no-auth' }))}`);
    assert.strictEqual(res.status, 401);
    assert.match((await res.json()).error, /Authorization header required/);
});

// Torque retries frames (GPS reconnect, app restart mid-send). The ingest path
// relies on the hypertable's unique index + bulkCreate(ignoreDuplicates) so a
// redelivered frame is a silent no-op, not a duplicate row and not a 500.
test('a duplicate frame is ignored (ON CONFLICT) and still answers OK!', async (t) => {
    if (state.skip) return t.skip(state.skip);
    await resetDatabase();

    const { email, cookie } = await registerAndLogin();
    const sessionKey = 'it-trip-dup';
    const [frame] = makeSeries({ session: sessionKey, eml: email, count: 1 });
    await uploadSeries([frame]);

    const session = await Session.findOne({ where: { sessionId: sessionKey } });
    assert.ok(session, 'first upload must create the session');
    assert.strictEqual(await Log.count({ where: { sessionId: session.id } }), 1);

    // Same wire frame, byte for byte: same sessionId + timestamp + values.
    const replay = await uploadFrame(frame);
    assert.strictEqual(replay.status, 200, 'replaying a frame must not error');
    assert.strictEqual(await replay.text(), 'OK!');
    await ingestBuffer.drain();

    assert.strictEqual(
        await Log.count({ where: { sessionId: session.id } }),
        1,
        'a redelivered frame must not create a second row'
    );
    const listed = await listSessions(cookie);
    assert.strictEqual(listed.total, 1);
    assert.strictEqual(listed.sessions[0].maxRpm, 800, 'duplicate must not skew summaries');
});

function importAppProcess() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', "require('./app')"], {
            cwd: ROOT,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut: true });
        }, 5000);
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr, timedOut: false });
        });
    });
}

// `require('./app')` must only export the wired router: a require.main guard
// around bootstrap() means importing never syncs, never listens, and never
// starts background timers — the property both integration files depend on.
test('importing app.js never listens or syncs', async (t) => {
    if (state.skip) return t.skip(state.skip);

    const result = await importAppProcess();
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(!result.timedOut, `importing app.js did not exit within 5s (output: ${output})`);
    assert.strictEqual(result.code, 0, `importing app.js exited ${result.code}: ${output}`);
    assert.doesNotMatch(output, /Listening on port/, 'importing app.js must not start the HTTP listener');
    assert.doesNotMatch(output, /Connection to database successfully established/, 'importing app.js must not run sequelize.sync()');
});
