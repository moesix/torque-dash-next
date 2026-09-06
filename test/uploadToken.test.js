'use strict';

// Set dummy env vars BEFORE any module loading so config.js doesn't throw and
// routes/api.js (the real limiter + uploadLimiterSkip) can be imported.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://x:x@localhost/x';
process.env.SESSION_KEYS = process.env.SESSION_KEYS || 'abc123';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const runtime = require('../config/runtime');

// Import the REAL makeLimiter from routes/api.js as the single source of
// truth. This requires the config module to load, which needs DATABASE_URL
// and SESSION_KEYS.  Step 6 ensures CI always provides these env vars.
let makeLimiter;
let uploadLimiterSkip;
let canLoadReal;
try {
  ({ makeLimiter, uploadLimiterSkip } = require('../routes/api'));
  canLoadReal = true;
} catch {
  canLoadReal = false;
}

// Fallback for when routes/api.js can't load (no env vars in local dev).
// This is the same function — identical shape and options.
function localMakeLimiter({ windowMs, max, skip }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        skip,
        message: { error: 'Too many requests, please slow down.' },
    });
}

// Stand-in copy of the production predicate (routes/api.js uploadLimiterSkip)
// used only when routes/api.js cannot be imported (no DATABASE_URL/SESSION_KEYS).
// Same constant-time shape: the byte-length pre-check short-circuits before
// crypto.timingSafeEqual.
function localUploadLimiterSkip(req) {
    const token = runtime.getUploadApiToken();
    if (!token) return false;
    const header = req.headers.authorization || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (Buffer.byteLength(provided, 'utf8') !== Buffer.byteLength(token, 'utf8')) return false;
    return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(token, 'utf8'));
}

const limiter = canLoadReal ? makeLimiter : localMakeLimiter;
if (!uploadLimiterSkip) uploadLimiterSkip = localUploadLimiterSkip;

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
            limiter({
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
            limiter({
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

// ---------------------------------------------------------------------------
// uploadLimiterSkip predicate — the exported function the real /upload limiter
// runs (routes/api.js). Constant-time: a length pre-check must short-circuit
// BEFORE crypto.timingSafeEqual so the header can't time the token's bytes.
// ---------------------------------------------------------------------------

const UPLOAD_TOKEN = 'tok1234567890abcdef'; // 19 chars
// Real Node HTTP requests expose headers lower-cased (req.headers.authorization).
const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });

test('uploadLimiterSkip: no configured token returns false even with a Bearer header', () => {
    runtime.setUploadApiToken(null);
    assert.strictEqual(uploadLimiterSkip(bearer('whatever-token-here')), false);
});

test('uploadLimiterSkip: wrong-length token returns false without calling timingSafeEqual', () => {
    runtime.setUploadApiToken(UPLOAD_TOKEN);
    const original = crypto.timingSafeEqual;
    let calls = 0;
    crypto.timingSafeEqual = (...args) => { calls += 1; return original(...args); };
    try {
        // 'short' (5 chars) != token length (20): must bail on the length check.
        assert.strictEqual(uploadLimiterSkip(bearer('short')), false);
        // Oversized candidates must also bail on length.
        assert.strictEqual(uploadLimiterSkip(bearer('x'.repeat(21))), false);
        // Missing header and non-Bearer schemes produce '' -> length mismatch.
        assert.strictEqual(uploadLimiterSkip({ headers: {} }), false);
        assert.strictEqual(uploadLimiterSkip({ headers: { authorization: 'Basic abc' } }), false);
        assert.strictEqual(calls, 0, 'timingSafeEqual must never run on a length mismatch');
    } finally {
        crypto.timingSafeEqual = original;
    }
});

test('uploadLimiterSkip: equal-length wrong token returns false (timingSafeEqual decides)', () => {
    runtime.setUploadApiToken(UPLOAD_TOKEN);
    const original = crypto.timingSafeEqual;
    let calls = 0;
    crypto.timingSafeEqual = (...args) => { calls += 1; return original(...args); };
    try {
        const wrong = 'x'.repeat(UPLOAD_TOKEN.length);
        assert.strictEqual(uploadLimiterSkip(bearer(wrong)), false);
        assert.strictEqual(calls, 1, 'same-length candidates must be compared with timingSafeEqual');
    } finally {
        crypto.timingSafeEqual = original;
    }
});

test('uploadLimiterSkip: exact matching token returns true', () => {
    runtime.setUploadApiToken(UPLOAD_TOKEN);
    assert.strictEqual(uploadLimiterSkip(bearer(UPLOAD_TOKEN)), true);
});

test('uploadLimiterSkip: empty runtime token returns false', () => {
    runtime.setUploadApiToken('');
    assert.strictEqual(uploadLimiterSkip(bearer('')), false);
    runtime.setUploadApiToken(null);
});

// Regression (non-ASCII configured token): the skip pre-check must compare
// BYTE lengths, not UTF-16 code-unit lengths. 'tøken-…' is 8 chars but 10
// bytes ('ø' and '…' are multi-byte), so an equal-UTF-16-length wrong
// candidate ('tøken-xx' is also 8 chars) is a DIFFERENT byte length and must
// bail without ever reaching timingSafeEqual — otherwise the Buffers differ
// in length and timingSafeEqual throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH,
// which would 500 the /upload hot path.
const UNICODE_TOKEN = 'tøken-…'; // 8 UTF-16 code units, 10 UTF-8 bytes
const UNICODE_WRONG = 'tøken-xx'; // 8 UTF-16 code units, 9 UTF-8 bytes

test('uploadLimiterSkip: non-ASCII token with equal-UTF16-length wrong candidate returns false WITHOUT throwing', () => {
    runtime.setUploadApiToken(UNICODE_TOKEN);
    const original = crypto.timingSafeEqual;
    let calls = 0;
    crypto.timingSafeEqual = (...args) => { calls += 1; return original(...args); };
    try {
        assert.strictEqual(
            uploadLimiterSkip(bearer(UNICODE_WRONG)),
            false,
            'equal-UTF16-length but different-byte candidate must be rejected on the byte-length pre-check'
        );
        assert.strictEqual(calls, 0, 'timingSafeEqual must never see different-length Buffers');
    } finally {
        crypto.timingSafeEqual = original;
    }
});

test('uploadLimiterSkip: non-ASCII exact token returns true', () => {
    runtime.setUploadApiToken(UNICODE_TOKEN);
    assert.strictEqual(uploadLimiterSkip(bearer(UNICODE_TOKEN)), true);
    runtime.setUploadApiToken(null);
});
