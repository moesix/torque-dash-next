'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const csrfGuard = require('../middleware/csrfGuard');

function startServer(allowed) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(csrfGuard(allowed));
    app.get('/x', (req, res) => res.json({ ok: true }));
    app.post('/x', (req, res) => res.json({ ok: true }));
    app.delete('/x', (req, res) => res.json({ ok: true }));
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

test('same-origin POST (Origin matches Host) is allowed', async () => {
    const { server, base } = await startServer([]);
    try {
        const url = new URL(base);
        const r = await fetch(base + '/x', {
            method: 'POST',
            headers: { Origin: `http://${url.hostname}:${url.port}` },
        });
        assert.strictEqual(r.status, 200);
    } finally {
        server.close();
    }
});

test('cross-origin POST from an untrusted origin is rejected (403)', async () => {
    const { server, base } = await startServer([]);
    try {
        const r = await fetch(base + '/x', {
            method: 'POST',
            headers: { Origin: 'https://evil.example.com' },
        });
        assert.strictEqual(r.status, 403);
        assert.strictEqual((await r.json()).error, 'Cross-origin request forbidden.');
    } finally {
        server.close();
    }
});

test('cross-origin POST from a trusted (allowlisted) origin is allowed', async () => {
    const { server, base } = await startServer(['https://app.example.com']);
    try {
        const r = await fetch(base + '/x', {
            method: 'POST',
            headers: { Origin: 'https://app.example.com' },
        });
        assert.strictEqual(r.status, 200);
    } finally {
        server.close();
    }
});

test('POST with no Origin header (curl / native client) is allowed', async () => {
    const { server, base } = await startServer([]);
    try {
        const r = await fetch(base + '/x', { method: 'POST' });
        assert.strictEqual(r.status, 200);
    } finally {
        server.close();
    }
});

test('GET with an attacker Origin is allowed (safe method exempt)', async () => {
    const { server, base } = await startServer([]);
    try {
        const r = await fetch(base + '/x', {
            method: 'GET',
            headers: { Origin: 'https://evil.example.com' },
        });
        assert.strictEqual(r.status, 200);
    } finally {
        server.close();
    }
});

test('DELETE with an untrusted Origin is rejected (403)', async () => {
    const { server, base } = await startServer([]);
    try {
        const r = await fetch(base + '/x', {
            method: 'DELETE',
            headers: { Origin: 'https://evil.example.com' },
        });
        assert.strictEqual(r.status, 403);
    } finally {
        server.close();
    }
});
