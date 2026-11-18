'use strict';

// Plan 028 — real-database coverage for the four destructive session
// operations (cut / filter / copy / join) and the summary recompute that
// follows each. Everything goes through the real HTTP surface (in-process
// server + fetch): register → login → GET /api/upload → ingestBuffer.drain() →
// sessions → telemetry → mutation → telemetry/summary.
//
// The suite OWNS the target database: before() runs the idempotent migrations
// itself and truncates the app tables once. Every test seeds its own user and
// sessions, so it does not depend on boot/ingest/prodBoot ordering or on the
// order of the tests below. The destructive reset is guarded — it refuses to
// run unless NODE_ENV=test or INTEGRATION_RESET_DB=1.
//
// Env is pinned before the app is required (config.js throws without
// DATABASE_URL / SESSION_KEYS); a missing/unreachable database SKIPS locally
// but FAILS in CI (`CI=true`), matching the rest of the integration suite.

// This file registers several independent users (one per test). Lift the auth
// limiter (10/min by default) so the suite's own traffic cannot 429 itself;
// the limiter itself is covered elsewhere. Must be set before config.js loads.
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { makeFrame } = require('./fixtures/torqueFrames');

const ROOT = path.join(__dirname, '..');
const CI = process.env.CI === 'true';

// 2026-01-01T00:00:00Z. The upload endpoint reads `time` as epoch milliseconds
// (UploadController: `new Date(Number(t))`), so every frame carries an explicit
// timestamp — never the server-now fallback.
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

let app;
let models;
let sequelize;
let ingestBuffer;
let runtime;
let Settings;
let loadError = null;

try {
    app = require('../app');
    models = require('../models');
    sequelize = models.sequelize;
    ingestBuffer = require('../services/ingestBuffer');
    runtime = require('../config/runtime');
    Settings = models.Settings;
} catch (err) {
    loadError = err;
}

const state = { skip: null, server: null, base: null };

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
    if (!process.env.DATABASE_URL) return 'DATABASE_URL not set — no database to mutate';
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

    // Self-sufficient boot: run the idempotent migrations, then clear the app
    // tables so this file never inherits another suite's rows.
    const migrated = migrate();
    assert.match(migrated, /\[migrate\] Done\./, `sessionMutations migrate did not finish:\n${migrated}`);
    await resetDatabase();

    await runtime.initUploadApiToken(models);
    state.server = http.createServer(app);
    await new Promise((resolve) => state.server.listen(0, '127.0.0.1', resolve));
    state.base = `http://127.0.0.1:${state.server.address().port}`;
});

after(async () => {
    if (state.server) await new Promise((resolve) => state.server.close(resolve));
    if (sequelize) await sequelize.close();
});

// Same destructive-reset contract as ingest.test.js / prodBoot.test.js.
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

async function request(pathname, { method = 'GET', cookie, body } = {}) {
    return fetch(`${state.base}${pathname}`, {
        method,
        redirect: 'manual',
        headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
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
    const email = `mut-${Date.now()}-${userSeq++}@example.com`;
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

// Assert a status without consuming the body on success (reading it in the
// assertion message would make a later res.json() throw "Body is unusable").
async function expectStatus(res, expected, label) {
    if (res.status === expected) return;
    assert.strictEqual(res.status, expected, `${label}: ${await res.text()}`);
}

async function createVehicle(cookie, name) {
    const res = await request('/api/vehicles', {
        method: 'POST',
        cookie,
        body: { name },
    });
    await expectStatus(res, 201, 'vehicle create failed');
    return res.json();
}

async function uploadFrame(frame) {
    const query = new URLSearchParams(frame).toString();
    return request(`/api/upload?${query}`);
}

// Upload `count` frames, one per second, with the plan's deterministic ramp:
// rpm = 1000 + i*100, speed = 20 + i, GPS offset by i. `extra` is merged into
// every wire frame (e.g. `v` for the vehicle profile name).
async function seedFrames({ email, session, start = BASE, count = 20, extra = {} }) {
    for (let i = 0; i < count; i++) {
        const frame = makeFrame({
            eml: email,
            session,
            t: start + i * 1000,
            rpm: 1000 + i * 100,
            speed: 20 + i,
            lat: 45.5017 + i * 0.001,
            lon: -73.5673 + i * 0.001,
            ...extra,
        });
        const res = await uploadFrame(frame);
        const body = await res.text();
        assert.strictEqual(res.status, 200, `upload failed: ${body}`);
        assert.strictEqual(body, 'OK!');
    }
    // Quiesce the buffer exactly like the copy/cut/filter/join handlers do.
    await ingestBuffer.drain();
}

async function listSessions(cookie) {
    const res = await request('/api/sessions', { cookie });
    await expectStatus(res, 200, 'list failed');
    return res.json();
}

async function findSessionBySessionKey(cookie, sessionKey) {
    const listed = await listSessions(cookie);
    const session = listed.sessions.find((s) => s.sessionId === sessionKey);
    assert.ok(session, `session ${sessionKey} must be listed`);
    return session;
}

async function findSessionByName(cookie, name) {
    const listed = await listSessions(cookie);
    const session = listed.sessions.find((s) => s.name === name);
    assert.ok(session, `session named ${name} must be listed`);
    return session;
}

async function getSession(cookie, id) {
    const res = await request(`/api/sessions/${id}`, { cookie });
    await expectStatus(res, 200, 'get session failed');
    return res.json();
}

// Telemetry over the full fixture window. `limit` is high enough for the
// 20-frame fixture and the 40-frame join union.
async function telemetry(cookie, id, { from = BASE, to = BASE + 60_000 } = {}) {
    const qs = `from=${encodeURIComponent(new Date(from).toISOString())}` +
        `&to=${encodeURIComponent(new Date(to).toISOString())}&limit=100`;
    const res = await request(`/api/sessions/${id}/telemetry?${qs}`, { cookie });
    await expectStatus(res, 200, 'telemetry failed');
    return res.json();
}

function timestampsOf(rows) {
    return rows.map((r) => new Date(r.timestamp).getTime());
}

function offsetsOf(rows) {
    return timestampsOf(rows).map((t) => (t - BASE) / 1000);
}

// ── Step 1 + 2: baseline fixture and cut ────────────────────────────────────

test('baseline fixture: 20 frames, maxRpm 2900, maxSpeed 39', async (t) => {
    if (state.skip) return t.skip(state.skip);

    const { email, cookie } = await registerAndLogin();
    await createVehicle(cookie, 'Cut Car');
    await seedFrames({ email, session: '028-cut', extra: { v: 'Cut Car' } });

    const session = await findSessionBySessionKey(cookie, '028-cut');
    const rows = await telemetry(cookie, session.id);
    assert.strictEqual(rows.length, 20, 'baseline must hold exactly 20 frames');
    assert.deepStrictEqual(offsetsOf(rows), Array.from({ length: 20 }, (_, i) => i),
        'baseline timestamps are +0s…+19s');

    const detail = await getSession(cookie, session.id);
    assert.strictEqual(detail.maxRpm, 2900, 'maxRpm = 1000 + 19*100');
    assert.strictEqual(detail.maxSpeed, 39, 'maxSpeed = 20 + 19');
});

test('cut: interior range is inclusive, tail cut lowers the summary, invalid/foreign rejected', async (t) => {
    if (state.skip) return t.skip(state.skip);

    const { email, cookie } = await registerAndLogin();
    await createVehicle(cookie, 'Cut Car 2');
    await seedFrames({ email, session: '028-cut-ops', extra: { v: 'Cut Car 2' } });
    const session = await findSessionBySessionKey(cookie, '028-cut-ops');

    // Interior cut +5s…+9s inclusive: 5 rows removed, maxima untouched (the
    // deleted range holds rpm 1500-1900 / speed 25-29).
    const cut = await request(`/api/sessions/cut/${session.id}`, {
        method: 'PATCH',
        cookie,
        body: {
            from: new Date(BASE + 5000).toISOString(),
            to: new Date(BASE + 9000).toISOString(),
        },
    });
    assert.strictEqual(cut.status, 200, `interior cut failed: ${await cut.text()}`);

    const afterInterior = await telemetry(cookie, session.id);
    assert.deepStrictEqual(
        offsetsOf(afterInterior),
        [0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
        'cut deletes +5s…+9s inclusive and keeps everything else'
    );
    let detail = await getSession(cookie, session.id);
    assert.strictEqual(detail.maxRpm, 2900, 'interior cut leaves maxRpm (i=19 remains)');
    assert.strictEqual(detail.maxSpeed, 39, 'interior cut leaves maxSpeed (i=19 remains)');

    // Tail cut +15s…+19s removes the true maxima: recompute must lower them.
    const tail = await request(`/api/sessions/cut/${session.id}`, {
        method: 'PATCH',
        cookie,
        body: {
            from: new Date(BASE + 15000).toISOString(),
            to: new Date(BASE + 19000).toISOString(),
        },
    });
    assert.strictEqual(tail.status, 200, `tail cut failed: ${await tail.text()}`);

    const afterTail = await telemetry(cookie, session.id);
    assert.deepStrictEqual(offsetsOf(afterTail), [0, 1, 2, 3, 4, 10, 11, 12, 13, 14],
        'tail cut leaves the ten surviving frames');
    detail = await getSession(cookie, session.id);
    assert.strictEqual(detail.maxRpm, 2400, 'recompute after deletion lowers maxRpm to i=14');
    assert.strictEqual(detail.maxSpeed, 34, 'recompute after deletion lowers maxSpeed to i=14');

    // Invalid range (from > to) must be a 400, never a 500.
    const invalid = await request(`/api/sessions/cut/${session.id}`, {
        method: 'PATCH',
        cookie,
        body: {
            from: new Date(BASE + 10000).toISOString(),
            to: new Date(BASE + 5000).toISOString(),
        },
    });
    assert.strictEqual(invalid.status, 400, 'from > to must be rejected by Joi');

    // A second user's session id must 404 and stay untouched.
    const other = await registerAndLogin();
    await seedFrames({ email: other.email, session: '028-cut-foreign' });
    const foreign = await findSessionBySessionKey(other.cookie, '028-cut-foreign');

    const foreignCut = await request(`/api/sessions/cut/${foreign.id}`, {
        method: 'PATCH',
        cookie,
        body: {
            from: new Date(BASE).toISOString(),
            to: new Date(BASE + 1000).toISOString(),
        },
    });
    assert.strictEqual(foreignCut.status, 404, 'cutting a foreign session must 404');
    const foreignRows = await telemetry(other.cookie, foreign.id);
    assert.strictEqual(foreignRows.length, 20, 'a rejected foreign cut must not delete rows');
});

// ── Step 3: filter ──────────────────────────────────────────────────────────

test('filter: keeps every Nth row (1-indexed), oversize is a no-op, invalid rejected', async (t) => {
    if (state.skip) return t.skip(state.skip);

    const { email, cookie } = await registerAndLogin();

    // PRODUCT BUG (reported, not fixed — plan 028 is test-only):
    // the handler's comment and docs/architecture.md say "downsample to every
    // Nth row", but its SQL keeps `rn % N != 0` and DELETEs the multiples via
    // `id NOT IN (…)`, i.e. it keeps every row EXCEPT the Nth. The assertions
    // below pin that observed behaviour so the suite is honest; the intended
    // contract is recorded as a `todo` test at the bottom of this file.
    //
    // filterNumber 2 on a fresh 20-frame session: multiples (rn 2,4,…20) are
    // deleted → the ten odd positions remain, i.e. +0s,+2s,…,+18s.
    await seedFrames({ email, session: '028-filter-2' });
    const s2 = await findSessionBySessionKey(cookie, '028-filter-2');
    const f2 = await request(`/api/sessions/filter/${s2.id}`, {
        method: 'PATCH',
        cookie,
        body: { filterNumber: 2 },
    });
    assert.strictEqual(f2.status, 200, `filter 2 failed: ${await f2.text()}`);
    const rows2 = await telemetry(cookie, s2.id);
    assert.deepStrictEqual(offsetsOf(rows2), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
        'observed: filterNumber 2 deletes rows at positions 2,4,…20');

    // filterNumber 5 on a fresh 20-frame session: positions 5,10,15,20 are
    // deleted, leaving 16 frames (not the 4 that "keep every Nth" would give).
    await seedFrames({ email, session: '028-filter-5' });
    const s5 = await findSessionBySessionKey(cookie, '028-filter-5');
    const f5 = await request(`/api/sessions/filter/${s5.id}`, {
        method: 'PATCH',
        cookie,
        body: { filterNumber: 5 },
    });
    assert.strictEqual(f5.status, 200, `filter 5 failed: ${await f5.text()}`);
    const rows5 = await telemetry(cookie, s5.id);
    assert.deepStrictEqual(
        offsetsOf(rows5),
        [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 18],
        'observed: filterNumber 5 deletes rows at positions 5,10,15,20'
    );

    // filterNumber greater than the row count is a 200 no-op.
    await seedFrames({ email, session: '028-filter-big' });
    const sBig = await findSessionBySessionKey(cookie, '028-filter-big');
    const fBig = await request(`/api/sessions/filter/${sBig.id}`, {
        method: 'PATCH',
        cookie,
        body: { filterNumber: 1000 },
    });
    assert.strictEqual(fBig.status, 200, 'filterNumber > count must be a 200 no-op');
    const rowsBig = await telemetry(cookie, sBig.id);
    assert.strictEqual(rowsBig.length, 20, 'oversize filter changes nothing');
    const bigDetail = await getSession(cookie, sBig.id);
    assert.strictEqual(bigDetail.maxRpm, 2900, 'oversize filter leaves the summary intact');

    // Joi bounds: min 2 and integer only.
    const one = await request(`/api/sessions/filter/${sBig.id}`, {
        method: 'PATCH',
        cookie,
        body: { filterNumber: 1 },
    });
    assert.strictEqual(one.status, 400, 'filterNumber 1 violates the Joi min');
    const abc = await request(`/api/sessions/filter/${sBig.id}`, {
        method: 'PATCH',
        cookie,
        body: { filterNumber: 'abc' },
    });
    assert.strictEqual(abc.status, 400, 'filterNumber "abc" is not a number');
});

// Reported product bug, recorded but not enforced: the documented contract
// ("downsample to every Nth row") is the inverse of the current SQL. This
// `todo` test proves the discrepancy deterministically; it is expected to fail
// until the controller is fixed in a follow-up (plan 028 must not touch it).
test('filter: INTENDED contract — keeps every Nth row (currently violated)', {
    todo: 'BUG: filter deletes every Nth row instead of keeping every Nth (SessionController.filter)',
}, async (t) => {
    if (state.skip) return t.skip(state.skip);

    const { email, cookie } = await registerAndLogin();

    await seedFrames({ email, session: '028-filter-intended-2' });
    const s2 = await findSessionBySessionKey(cookie, '028-filter-intended-2');
    const f2 = await request(`/api/sessions/filter/${s2.id}`, {
        method: 'PATCH',
        cookie,
        body: { filterNumber: 2 },
    });
    assert.strictEqual(f2.status, 200, `filter 2 failed: ${await f2.text()}`);
    const rows2 = await telemetry(cookie, s2.id);
    assert.deepStrictEqual(offsetsOf(rows2), [1, 3, 5, 7, 9, 11, 13, 15, 17, 19],
        'the docs promise to keep positions 2,4,… (i.e. +1s,+3s,…)');

    await seedFrames({ email, session: '028-filter-intended-5' });
    const s5 = await findSessionBySessionKey(cookie, '028-filter-intended-5');
    const f5 = await request(`/api/sessions/filter/${s5.id}`, {
        method: 'PATCH',
        cookie,
        body: { filterNumber: 5 },
    });
    assert.strictEqual(f5.status, 200, `filter 5 failed: ${await f5.text()}`);
    const rows5 = await telemetry(cookie, s5.id);
    assert.deepStrictEqual(offsetsOf(rows5), [4, 9, 14, 19],
        'the docs promise 20/5 = four surviving frames');
});

// ── Step 4: copy and join ───────────────────────────────────────────────────

test('copy: copies frames, summary, vehicle, locations and notes; foreign copy 404s', async (t) => {
    if (state.skip) return t.skip(state.skip);

    const { email, cookie } = await registerAndLogin();
    const vehicle = await createVehicle(cookie, 'Copy Car');
    await seedFrames({ email, session: '028-copy', extra: { v: 'Copy Car' } });
    const source = await findSessionBySessionKey(cookie, '028-copy');

    const loc = await request(`/api/sessions/addlocation/${source.id}`, {
        method: 'PATCH',
        cookie,
        body: { locations: { start: 'Montreal', end: 'Quebec' } },
    });
    assert.strictEqual(loc.status, 200, `addlocation failed: ${await loc.text()}`);
    const notes = await request(`/api/sessions/notes/${source.id}`, {
        method: 'PATCH',
        cookie,
        body: { notes: 'notes on the original trip' },
    });
    assert.strictEqual(notes.status, 200, `notes failed: ${await notes.text()}`);

    const sourceDetail = await getSession(cookie, source.id);
    assert.strictEqual(sourceDetail.startLocation, 'Montreal');
    assert.strictEqual(sourceDetail.endLocation, 'Quebec');
    assert.strictEqual(sourceDetail.notes, 'notes on the original trip');
    assert.strictEqual(sourceDetail.vehicleId, vehicle.id);

    const copy = await request(`/api/sessions/copy/${source.id}`, {
        method: 'POST',
        cookie,
        body: { name: 'copy of trip' },
    });
    assert.strictEqual(copy.status, 200, `copy failed: ${await copy.text()}`);

    const copied = await findSessionByName(cookie, 'copy of trip');
    assert.notStrictEqual(copied.id, source.id, 'copy must be a new session row');
    assert.notStrictEqual(copied.sessionId, source.sessionId, 'copy gets a fresh nanoid sessionId');

    const copiedRows = await telemetry(cookie, copied.id);
    assert.strictEqual(copiedRows.length, 20, 'copy must carry every source frame');
    assert.deepStrictEqual(offsetsOf(copiedRows), Array.from({ length: 20 }, (_, i) => i));
    assert.deepStrictEqual(
        copiedRows.map((r) => r.engine_rpm),
        Array.from({ length: 20 }, (_, i) => 1000 + i * 100),
        'copied rows keep the source values'
    );

    const copiedDetail = await getSession(cookie, copied.id);
    assert.strictEqual(copiedDetail.maxRpm, sourceDetail.maxRpm, 'copy recomputes the same maxRpm');
    assert.strictEqual(copiedDetail.maxSpeed, sourceDetail.maxSpeed, 'copy recomputes the same maxSpeed');
    assert.strictEqual(copiedDetail.maxRpm, 2900);
    assert.strictEqual(copiedDetail.maxSpeed, 39);
    assert.strictEqual(copiedDetail.vehicleId, vehicle.id, 'copy inherits vehicleId');
    assert.strictEqual(copiedDetail.startLocation, 'Montreal', 'copy inherits startLocation');
    assert.strictEqual(copiedDetail.endLocation, 'Quebec', 'copy inherits endLocation');
    assert.strictEqual(copiedDetail.notes, 'notes on the original trip', 'copy inherits notes');

    // Foreign copy: 404 and no new row for this user.
    const other = await registerAndLogin();
    await seedFrames({ email: other.email, session: '028-copy-foreign' });
    const foreign = await findSessionBySessionKey(other.cookie, '028-copy-foreign');

    const beforeList = await listSessions(cookie);
    const foreignCopy = await request(`/api/sessions/copy/${foreign.id}`, {
        method: 'POST',
        cookie,
        body: { name: 'stolen copy' },
    });
    assert.strictEqual(foreignCopy.status, 404, 'copying a foreign session must 404');
    const afterList = await listSessions(cookie);
    assert.strictEqual(afterList.total, beforeList.total, 'a rejected foreign copy creates no session');
    assert.ok(!afterList.sessions.some((s) => s.name === 'stolen copy'));
});

test('join: disjoint sources union to 40 frames, overlapping sources dedupe, vehicle inherited', async (t) => {
    if (state.skip) return t.skip(state.skip);

    const { email, cookie } = await registerAndLogin();
    const vehicle = await createVehicle(cookie, 'Join Car');

    // Disjoint fixtures: A = +0s…+19s, B = +20s…+39s (union 40 timestamps).
    await seedFrames({ email, session: '028-join-a', extra: { v: 'Join Car' } });
    await seedFrames({ email, session: '028-join-b', start: BASE + 20_000, extra: { v: 'Join Car' } });
    const first = await findSessionBySessionKey(cookie, '028-join-a');
    const second = await findSessionBySessionKey(cookie, '028-join-b');

    const joined = await request(`/api/sessions/join/${first.id}`, {
        method: 'POST',
        cookie,
        body: { joinSessionId: second.id, name: 'joined disjoint' },
    });
    assert.strictEqual(joined.status, 200, `join failed: ${await joined.text()}`);

    const joinedSession = await findSessionByName(cookie, 'joined disjoint');
    const joinedRows = await telemetry(cookie, joinedSession.id);
    assert.strictEqual(joinedRows.length, 40, 'disjoint sources union to 40 frames');
    assert.deepStrictEqual(offsetsOf(joinedRows), Array.from({ length: 40 }, (_, i) => i),
        'joined timestamps are the exact union +0s…+39s');

    const joinedDetail = await getSession(cookie, joinedSession.id);
    assert.strictEqual(joinedDetail.vehicleId, vehicle.id,
        'join inherits the primary (first) source vehicleId');
    assert.strictEqual(joinedDetail.maxRpm, 2900, 'joined maxRpm is the union maximum');
    assert.strictEqual(joinedDetail.maxSpeed, 39, 'joined maxSpeed is the union maximum');

    // Overlapping sources with identical timestamps: the second INSERT…SELECT
    // hits ON CONFLICT ("sessionId", timestamp) DO NOTHING, so the target is
    // the 20-frame union, never 40.
    await seedFrames({ email, session: '028-join-c' }); // same +0s…+19s timestamps
    const third = await findSessionBySessionKey(cookie, '028-join-c');

    const dedupe = await request(`/api/sessions/join/${first.id}`, {
        method: 'POST',
        cookie,
        body: { joinSessionId: third.id, name: 'joined dedupe' },
    });
    assert.strictEqual(dedupe.status, 200, `dedupe join failed: ${await dedupe.text()}`);

    const dedupeSession = await findSessionByName(cookie, 'joined dedupe');
    const dedupeRows = await telemetry(cookie, dedupeSession.id);
    assert.strictEqual(dedupeRows.length, 20,
        'overlapping sources must dedupe on (sessionId, timestamp)');
    assert.deepStrictEqual(offsetsOf(dedupeRows), Array.from({ length: 20 }, (_, i) => i));
});
