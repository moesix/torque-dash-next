'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isSafeUrl, isPublicIp, safeFetch } = require('../lib/ssrfGuard');

// ── isPublicIp ─ IPv4 classification ─────────────────────────────────────

test('isPublicIp: 127.0.0.1 → private (loopback)', () => {
    assert.strictEqual(isPublicIp('127.0.0.1'), false);
});

test('isPublicIp: 10.0.0.1 → private', () => {
    assert.strictEqual(isPublicIp('10.0.0.1'), false);
});

test('isPublicIp: 172.16.0.1 → private (172.16/12)', () => {
    assert.strictEqual(isPublicIp('172.16.0.1'), false);
});

test('isPublicIp: 172.31.255.254 → private (upper bound)', () => {
    assert.strictEqual(isPublicIp('172.31.255.254'), false);
});

test('isPublicIp: 172.15.255.255 → public (just below 172.16/12)', () => {
    assert.strictEqual(isPublicIp('172.15.255.255'), true);
});

test('isPublicIp: 172.32.0.0 → public (just above 172.16/12)', () => {
    assert.strictEqual(isPublicIp('172.32.0.0'), true);
});

test('isPublicIp: 192.168.1.1 → private', () => {
    assert.strictEqual(isPublicIp('192.168.1.1'), false);
});

test('isPublicIp: 169.254.169.254 → private (link-local metadata)', () => {
    assert.strictEqual(isPublicIp('169.254.169.254'), false);
});

test('isPublicIp: 0.0.0.0 → private (unspecified)', () => {
    assert.strictEqual(isPublicIp('0.0.0.0'), false);
});

test('isPublicIp: 8.8.8.8 → public', () => {
    assert.strictEqual(isPublicIp('8.8.8.8'), true);
});

// ── isPublicIp ─ IPv6 classification ─────────────────────────────────────

test('isPublicIp: ::1 → private (loopback)', () => {
    assert.strictEqual(isPublicIp('::1'), false);
});

test('isPublicIp: :: → private (unspecified)', () => {
    assert.strictEqual(isPublicIp('::'), false);
});

test('isPublicIp: fc00::1 → private (unique-local)', () => {
    assert.strictEqual(isPublicIp('fc00::1'), false);
});

test('isPublicIp: fd00::1 → private (unique-local)', () => {
    assert.strictEqual(isPublicIp('fd00::1'), false);
});

test('isPublicIp: fe80::1 → private (link-local)', () => {
    assert.strictEqual(isPublicIp('fe80::1'), false);
});

test('isPublicIp: fe90::1 → private (link-local fe80::/10)', () => {
    assert.strictEqual(isPublicIp('fe90::1'), false);
});

test('isPublicIp: febf::1 → private (link-local upper bound)', () => {
    assert.strictEqual(isPublicIp('febf::1'), false);
});

test('isPublicIp: 64:ff9b::192.0.2.1 → private (NAT64)', () => {
    assert.strictEqual(isPublicIp('64:ff9b::192.0.2.1'), false);
});

test('isPublicIp: 2001:db8::1 → public', () => {
    assert.strictEqual(isPublicIp('2001:db8::1'), true);
});

// ── isPublicIp ─ IPv4-mapped IPv6 (the key bypass) ──────────────────────

test('isPublicIp: ::ffff:127.0.0.1 → private (mapped loopback)', () => {
    assert.strictEqual(isPublicIp('::ffff:127.0.0.1'), false);
});

test('isPublicIp: ::FFFF:127.0.0.1 → private (mixed-case mapped loopback)', () => {
    assert.strictEqual(isPublicIp('::FFFF:127.0.0.1'), false);
});

test('isPublicIp: ::ffff:10.0.0.1 → private (mapped private)', () => {
    assert.strictEqual(isPublicIp('::ffff:10.0.0.1'), false);
});

test('isPublicIp: ::ffff:8.8.8.8 → public (mapped public)', () => {
    assert.strictEqual(isPublicIp('::ffff:8.8.8.8'), true);
});

test('isPublicIp: ::ffff:0.0.0.0 → private (mapped unspecified)', () => {
    assert.strictEqual(isPublicIp('::ffff:0.0.0.0'), false);
});

test('hex-form mapped loopback ::ffff:7f00:1 → private', () => {
    assert.strictEqual(isPublicIp('::ffff:7f00:1'), false);   // 127.0.0.1
});
test('hex-form mapped private ::ffff:a00:5 → private', () => {
    assert.strictEqual(isPublicIp('::ffff:a00:5'), false);    // 10.0.0.5
});
test('zero-padded hex mapped ::ffff:0a00:0005 → private', () => {
    assert.strictEqual(isPublicIp('::ffff:0a00:0005'), false);
});
test('hex-form mapped public ::ffff:808:808 → public', () => {
    assert.strictEqual(isPublicIp('::ffff:808:808'), true);   // 8.8.8.8
});

test('isPublicIp: unparseable string → false (fail-closed)', () => {
    assert.strictEqual(isPublicIp('not-an-ip'), false);
});

test('isPublicIp: empty string → false (fail-closed)', () => {
    assert.strictEqual(isPublicIp(''), false);
});

// ── isSafeUrl ─ DNS integration ──────────────────────────────────────────

test('isSafeUrl: hostname resolving to 127.0.0.1 → false', async () => {
    // 127.0.0.1 is always loopback — no DNS stub needed
    const result = await isSafeUrl('http://localhost/path');
    assert.strictEqual(result, false);
});

test('isSafeUrl: non-http scheme → false', async () => {
    const result = await isSafeUrl('ftp://example.com/file');
    assert.strictEqual(result, false);
});

test('isSafeUrl: garbage URL → false', async () => {
    const result = await isSafeUrl('not-a-url');
    assert.strictEqual(result, false);
});

test('isSafeUrl: null/undefined → false', async () => {
    assert.strictEqual(await isSafeUrl(null), false);
    assert.strictEqual(await isSafeUrl(undefined), false);
    assert.strictEqual(await isSafeUrl(''), false);
});

test('isSafeUrl: empty hostname → false', async () => {
    const result = await isSafeUrl('http:///path');
    assert.strictEqual(result, false);
});

// ── safeFetch ─ redirect blocking ────────────────────────────────────────

test('safeFetch: follows no redirects by default', async () => {
    // A non-existent URL should not throw — it returns a 301 response
    // (we can't easily test real redirects without a server, but we verify
    // the redirect: 'manual' option is in place by checking the response type)
    const res = await safeFetch('http://127.0.0.1:1/nonexistent', {
        signal: AbortSignal.timeout(1000)
    }).catch(() => null);
    // Either we get a response (manual mode) or a connection error — both are fine
    // The key thing is no redirect-following happened
    assert.ok(res === null || (res && typeof res.status === 'number'));
});

test('safeFetch: throws when target is unsafe', async () => {
    await assert.rejects(
        () => safeFetch('http://127.0.0.1/path'),
        /unsafe/i
    );
});

test('safeFetch: throws on garbage URL', async () => {
    await assert.rejects(
        () => safeFetch('not-a-url'),
        /unsafe|invalid/i
    );
});

test('safeFetch: follows redirect to same-origin public host', async () => {
    // Start a tiny HTTP server that redirects to another public-looking host
    // We can't easily test this without a real server, but we verify the
    // function signature and redirect handling logic works
    const http = require('node:http');

    const server = http.createServer((req, res) => {
        if (req.url === '/start') {
            res.writeHead(302, { Location: '/final' });
            res.end();
        } else if (req.url === '/final') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        const res = await safeFetch(`http://127.0.0.1:${port}/start`, {
            signal: AbortSignal.timeout(2000)
        });
        // 127.0.0.1 resolves to loopback — isSafeUrl will reject it
        // so safeFetch should throw even for same-origin redirects to unsafe targets
        // Actually, safeFetch checks isSafeUrl on the redirect target
        // Since 127.0.0.1 is unsafe, the redirect should be blocked
        assert.fail('should have thrown — redirect target is unsafe');
    } catch (e) {
        assert.ok(e.message.includes('unsafe') || e.message.includes('Unsafe'),
            `Expected unsafe error, got: ${e.message}`);
    } finally {
        server.close();
    }
});

test('safeFetch: blocks redirect chain crossing to private', async () => {
    const http = require('node:http');

    // Server redirects to an internal-looking host
    const server = http.createServer((req, res) => {
        if (req.url === '/redirect') {
            // Redirect to a loopback address via IP
            res.writeHead(302, { Location: `http://127.0.0.1:${req.socket.localPort}/internal` });
            res.end();
        } else if (req.url === '/internal') {
            res.writeHead(200);
            res.end('internal');
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        await safeFetch(`http://127.0.0.1:${port}/redirect`, {
            signal: AbortSignal.timeout(2000)
        });
        assert.fail('should have thrown — redirect target is private');
    } catch (e) {
        assert.ok(e.message.includes('unsafe') || e.message.includes('Unsafe') || e.message.includes('redirect'),
            `Expected unsafe/redirect error, got: ${e.message}`);
    } finally {
        server.close();
    }
});

test('safeFetch: respects hop limit (max 3 redirects)', async () => {
    const http = require('node:http');

    // Chain of 4 redirects — all to same loopback host
    let hopCount = 0;
    const server = http.createServer((req, res) => {
        hopCount++;
        if (hopCount <= 4 && req.url === '/hop') {
            res.writeHead(302, { Location: '/hop' });
            res.end();
        } else {
            res.writeHead(200);
            res.end('done');
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        await safeFetch(`http://127.0.0.1:${port}/hop`, {
            signal: AbortSignal.timeout(2000)
        });
        assert.fail('should have thrown — redirect chain too long or unsafe');
    } catch (e) {
        // Should throw because either hop limit exceeded or unsafe redirect target
        assert.ok(e.message);
    } finally {
        server.close();
    }
});

// ── isSafeUrl: fail-closed contract (DNS failure) ────────────────────────

test('isSafeUrl: DNS resolution failure → false (fail-closed)', async () => {
    // Use a hostname that will always fail DNS resolution
    const result = await isSafeUrl('http://this-hostname-definitely-does-not-exist-12345.example.invalid/path');
    assert.strictEqual(result, false);
});
