'use strict';

// routes/api.js loads the config module, which needs DATABASE_URL and
// SESSION_KEYS. Set them before any require so the test always exercises the
// REAL makeLimiter (same pattern as test/dbWritePath.test.js).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'test-key-for-rate-limit-tests';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

// Single source of truth: the limiter the route factory actually wires.
const { makeLimiter } = require('../routes/api');

function startServer(configure) {
    const app = express();
    app.set('trust proxy', 1);
    configure(app);
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

test('config exposes tiered rate limits with sane defaults', () => {
    const { rateLimits } = require('../config/config');
    for (const tier of ['auth', 'upload', 'write', 'global']) {
        assert.ok(rateLimits[tier], `missing tier: ${tier}`);
        assert.ok(rateLimits[tier].windowMs > 0);
        assert.ok(rateLimits[tier].max > 0);
    }
    assert.ok(rateLimits.auth.max < rateLimits.global.max, 'auth should be stricter than global');
    assert.ok(rateLimits.upload.max >= rateLimits.global.max, 'upload absorbs bursts (>= reads)');
});

test('bursting past max returns a JSON 429', async () => {
    const { server, base } = await startServer((app) => {
        app.use(makeLimiter({ windowMs: 60000, max: 3 }));
        app.get('/x', (req, res) => res.json({ ok: true }));
    });
    try {
        for (let i = 0; i < 3; i++) {
            const r = await fetch(`${base}/x`);
            assert.strictEqual(r.status, 200);
        }
        const blocked = await fetch(`${base}/x`);
        assert.strictEqual(blocked.status, 429);
        const body = await blocked.json();
        assert.strictEqual(body.error, 'Too many requests, please slow down.');
    } finally {
        server.close();
    }
});

test('a matching Bearer token skips the upload limiter', async () => {
    const token = 'secret-token';
    const { server, base } = await startServer((app) => {
        app.use(
            makeLimiter({
                windowMs: 60000,
                max: 1,
                skip: (req) => (req.headers.authorization || '') === `Bearer ${token}`,
            })
        );
        app.get('/upload', (req, res) => res.json({ ok: true }));
    });
    try {
        const opts = { headers: { Authorization: `Bearer ${token}` } };
        for (let i = 0; i < 5; i++) {
            const r = await fetch(`${base}/upload`, opts);
            assert.strictEqual(r.status, 200, `request ${i} should bypass`);
        }
        // Without the token, the max:1 cap trips on the second request.
        assert.strictEqual((await fetch(`${base}/upload`)).status, 200);
        assert.strictEqual((await fetch(`${base}/upload`)).status, 429);
    } finally {
        server.close();
    }
});

test('the window resets after windowMs elapses', async () => {
    const { server, base } = await startServer((app) => {
        app.use(makeLimiter({ windowMs: 300, max: 1 }));
        app.get('/x', (req, res) => res.json({ ok: true }));
    });
    try {
        assert.strictEqual((await fetch(`${base}/x`)).status, 200);
        assert.strictEqual((await fetch(`${base}/x`)).status, 429);
        await new Promise((r) => setTimeout(r, 350));
        assert.strictEqual((await fetch(`${base}/x`)).status, 200);
    } finally {
        server.close();
    }
});
