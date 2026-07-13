'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const rateLimit = require('express-rate-limit');
const runtime = require('../config/runtime');

// Mirror routes/api.js helpers so we exercise the exact option shape without
// loading controllers, DB models, or the full application.
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

function makeLimiter({ windowMs, max, skip }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        skip,
        message: { error: 'Too many requests, please slow down.' },
    });
}

// ---------------------------------------------------------------------------
// Runtime unit tests — mock models.Settings.getSingleton() to isolate the
// token resolution logic from any real database.
// ---------------------------------------------------------------------------

test('runtime holder respects env override', async () => {
    process.env.UPLOAD_API_TOKEN = 'env-token-123';
    const mockModels = {
        Settings: {
            getSingleton: async () => ({ uploadApiToken: 'db-token' }),
        },
    };
    await runtime.initUploadApiToken(mockModels);
    assert.strictEqual(runtime.getUploadApiToken(), 'env-token-123');
    delete process.env.UPLOAD_API_TOKEN;
});

test('runtime holder falls back to DB when no env', async () => {
    delete process.env.UPLOAD_API_TOKEN;
    const mockModels = {
        Settings: {
            getSingleton: async () => ({ uploadApiToken: 'db-token-456' }),
        },
    };
    await runtime.initUploadApiToken(mockModels);
    assert.strictEqual(runtime.getUploadApiToken(), 'db-token-456');
});

test('runtime holder returns null when neither env nor DB', async () => {
    delete process.env.UPLOAD_API_TOKEN;
    const mockModels = {
        Settings: {
            getSingleton: async () => ({ uploadApiToken: null }),
        },
    };
    await runtime.initUploadApiToken(mockModels);
    assert.strictEqual(runtime.getUploadApiToken(), null);
});

test('setUploadApiToken updates the runtime value', () => {
    runtime.setUploadApiToken('new-token');
    assert.strictEqual(runtime.getUploadApiToken(), 'new-token');
});

// ---------------------------------------------------------------------------
// Integration tests — exercise the same skip predicate pattern used in
// routes/api.js, confirming the runtime token gates the rate-limiter bypass.
// ---------------------------------------------------------------------------

test('rate limiter skip uses runtime token (integration)', async () => {
    runtime.setUploadApiToken('test-bearer-token');
    const { server, base } = await startServer((app) => {
        app.use(
            makeLimiter({
                windowMs: 60000,
                max: 1,
                skip: (req) => {
                    const token = runtime.getUploadApiToken();
                    return Boolean(token) &&
                        (req.headers.authorization || '') === `Bearer ${token}`;
                },
            })
        );
        app.get('/test-upload', (req, res) => res.json({ ok: true }));
    });
    try {
        // With a matching bearer token the limiter should be skipped entirely.
        const authOpts = { headers: { Authorization: 'Bearer test-bearer-token' } };
        for (let i = 0; i < 3; i++) {
            const r = await fetch(`${base}/test-upload`, authOpts);
            assert.strictEqual(r.status, 200, `request ${i} with token should bypass limiter`);
        }

        // Without the token the max:1 cap should trip on the second request.
        assert.strictEqual(
            (await fetch(`${base}/test-upload`)).status,
            200,
            'first non-token request passes'
        );
        assert.strictEqual(
            (await fetch(`${base}/test-upload`)).status,
            429,
            'second non-token request is rate-limited'
        );
    } finally {
        server.close();
    }
});

test('runtime skip without token set', async () => {
    runtime.setUploadApiToken(null);
    const { server, base } = await startServer((app) => {
        app.use(
            makeLimiter({
                windowMs: 60000,
                max: 1,
                skip: (req) => {
                    const token = runtime.getUploadApiToken();
                    return Boolean(token) &&
                        (req.headers.authorization || '') === `Bearer ${token}`;
                },
            })
        );
        app.get('/test-upload', (req, res) => res.json({ ok: true }));
    });
    try {
        // With runtime token = null the skip predicate returns false, so the
        // rate limiter applies even when the request carries a bearer header.
        const authOpts = { headers: { Authorization: 'Bearer some-token' } };
        assert.strictEqual(
            (await fetch(`${base}/test-upload`, authOpts)).status,
            200,
            'first request passes (max:1)'
        );
        assert.strictEqual(
            (await fetch(`${base}/test-upload`, authOpts)).status,
            429,
            'second request is rate-limited (skip returned false)'
        );

        // Confirm the 429 body matches the expected JSON shape.
        const body = await (await fetch(`${base}/test-upload`, authOpts)).json();
        assert.strictEqual(body.error, 'Too many requests, please slow down.');
    } finally {
        server.close();
    }
});
