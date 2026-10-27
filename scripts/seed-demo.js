#!/usr/bin/env node
'use strict';

// Populate a development database with demo telemetry so a fresh checkout has
// something to browse before the first real Torque upload.
//
//   node scripts/seed-demo.js [--sessions=20] [--days=30]
//   docker compose -f docker-compose.dev.yml exec backend node scripts/seed-demo.js
//
// Requires DATABASE_URL (and SESSION_KEYS, because config.js demands it for the
// shared Sequelize instance). Rows are written through ingestBuffer — the same
// buffered flush path real uploads use — so the demo rows get promoted
// columns and denormalized summaries exactly like production ingest. Sessions
// are created first because Logs.sessionId is FK-enforced.

// Demo rows are fake by design and the credentials are printed to stdout;
// seeding a production database would create a working login for anyone who can
// read the log. Refuse before loading models/config (which requires DATABASE_URL).
if (process.env.NODE_ENV === 'production') {
    console.error(
        '[seed-demo] refusing to seed demo data with NODE_ENV=production: ' +
        'the demo credentials are public. Unset NODE_ENV or point at a disposable database.'
    );
    process.exit(1);
}

const models = require('../models');
const ingestBuffer = require('../services/ingestBuffer');
const { makeSeries, toIngestItem } = require('../integration/fixtures/torqueFrames');

const { sequelize, User, Session, Log } = models;

const DEMO_EMAIL = 'demo@torquedash.local';
const DEMO_PASSWORD = 'demo-password';
const FRAMES_PER_SESSION = 120;
const FRAME_INTERVAL_MS = 1000;

function parseArgs(argv) {
    const opts = { sessions: 20, days: 30 };
    for (const arg of argv) {
        const match = /^--(sessions|days)=(\d+)$/.exec(arg);
        if (match) {
            opts[match[1]] = Number(match[2]);
        } else if (arg === '--help' || arg === '-h') {
            opts.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!Number.isInteger(opts.sessions) || opts.sessions < 1 || opts.sessions > 500) {
        throw new Error('--sessions must be an integer between 1 and 500');
    }
    if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 3650) {
        throw new Error('--days must be an integer between 1 and 3650');
    }
    return opts;
}

function banner() {
    console.log('============================================================');
    console.log('DEMO DATA — fake credentials, never use in production');
    console.log(`  login: ${DEMO_EMAIL}`);
    console.log(`  password: ${DEMO_PASSWORD}`);
    console.log('============================================================');
}

async function demoUser() {
    const [user] = await User.findOrCreate({
        where: { email: DEMO_EMAIL },
        defaults: { email: DEMO_EMAIL, password: DEMO_PASSWORD, isAdmin: false },
    });
    return user;
}

async function clearDemoSessions(user) {
    const existing = await Session.findAll({
        where: { userId: user.id },
        attributes: ['id', 'sessionId'],
    });
    const ids = existing
        .filter((row) => String(row.sessionId || '').startsWith('demo-'))
        .map((row) => row.id);
    if (ids.length === 0) return 0;
    // Logs cascade with the session (Logs_sessionId_fkey ON DELETE CASCADE).
    await Session.destroy({ where: { id: ids } });
    return ids.length;
}

async function run() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('Usage: node scripts/seed-demo.js [--sessions=20] [--days=30]');
        return;
    }

    banner();
    const user = await demoUser();
    const removed = await clearDemoSessions(user);
    if (removed > 0) console.log(`[seed-demo] cleared ${removed} previous demo session(s)`);

    const now = Date.now();
    const sessionIds = [];
    for (let i = 0; i < opts.sessions; i++) {
        const dayBack = i % opts.days;
        const start = now - dayBack * 86_400_000 - (i % 8) * 3_600_000;
        const sessionKey = `demo-${i + 1}`;
        const frames = makeSeries({
            session: sessionKey,
            eml: DEMO_EMAIL,
            count: FRAMES_PER_SESSION,
            intervalMs: FRAME_INTERVAL_MS,
            start,
            rpmBase: 750 + (i % 5) * 120,
            speedBase: 25 + (i % 7) * 5,
        });

        const session = await Session.create({
            sessionId: sessionKey,
            userId: user.id,
            name: `Demo trip ${String(i + 1).padStart(2, '0')}`,
            startLocation: 'Demo start',
            endLocation: 'Demo end',
            createdAt: new Date(start),
            updatedAt: new Date(start),
        });
        sessionIds.push(session.id);

        for (const frame of frames) {
            ingestBuffer.ingest(toIngestItem(frame, { userId: user.id, sessionId: session.id }));
        }
    }
    await ingestBuffer.drain();

    const frames = await Log.count({ where: { sessionId: sessionIds } });
    console.log(
        `[seed-demo] ${sessionIds.length} session(s), ${frames} frame(s) across the last ${opts.days} day(s)`
    );
    console.log(`[seed-demo] open the SPA and sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

run()
    .catch((err) => {
        console.error('[seed-demo] failed:', err.message);
        process.exitCode = 1;
    })
    .finally(() => sequelize.close());
