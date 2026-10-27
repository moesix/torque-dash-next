'use strict';

// End-to-end ingest suite against a real migrations-only TimescaleDB.
// Everything goes through the real HTTP surface (in-process server + fetch):
// settings → register → login → GET /api/upload → ingestBuffer.drain() →
// sessions → telemetry → CSV → rename → delete (FK cascade) → re-upload.
//
// Env is pinned before the app is required (config.js throws without
// DATABASE_URL / SESSION_KEYS); when either is missing or the database is
// unreachable every test skips, so `npm run verify` stays DB-free.

process.env.UPLOAD_API_TOKEN = process.env.UPLOAD_API_TOKEN || 'integration-upload-token';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Client } = require('pg');
const { makeFrame, makeSeries } = require('./fixtures/torqueFrames');

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
    if (loadError) {
        state.skip = `app not loadable: ${loadError.message.split('\n')[0]}`;
        return;
    }
    if (!(await databaseReachable())) {
        state.skip = 'database unreachable';
        return;
    }
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
async function resetDatabase() {
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
