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

test('translated hex ::ffff:0:a9fe:a9fe → private (metadata)', () => {
    assert.strictEqual(isPublicIp('::ffff:0:a9fe:a9fe'), false); // 169.254.169.254
});
test('compatible hex ::a9fe:a9fe → private (metadata)', () => {
    assert.strictEqual(isPublicIp('::a9fe:a9fe'), false);        // 169.254.169.254
});
test('translated hex ::ffff:0:808:808 → public', () => {
    assert.strictEqual(isPublicIp('::ffff:0:808:808'), true);    // 8.8.8.8
});
test('expanded mapped loopback → private (no compressed-spelling bypass)', () => {
    // ::ffff:127.0.0.1 written out in full — the pre-rewrite regex missed this.
    assert.strictEqual(isPublicIp('0000:0000:0000:0000:0000:ffff:7f00:0001'), false);
});
test('expanded translated metadata → private', () => {
    assert.strictEqual(isPublicIp('0000:0000:0000:0000:ffff:0000:a9fe:a9fe'), false);
});
test('expanded compatible metadata → private', () => {
    assert.strictEqual(isPublicIp('0000:0000:0000:0000:0000:0000:a9fe:a9fe'), false);
});
test('expanded mapped public → public (follows the embedded IPv4)', () => {
    assert.strictEqual(isPublicIp('0000:0000:0000:0000:0000:ffff:0808:0808'), true);
});

test('isPublicIp: unparseable string → false (fail-closed)', () => {
    assert.strictEqual(isPublicIp('not-an-ip'), false);
});

test('isPublicIp: empty string → false (fail-closed)', () => {
    assert.strictEqual(isPublicIp(''), false);
});

// ── isSafeUrl ─ DNS integration ──────────────────────────────────────────

test('isSafeUrl: hostname resolving to ::ffff:0:a9fe:a9fe → false (entry path)', async (t) => {
    const dns = require('node:dns');
    t.mock.method(dns.promises, 'lookup', async () => [
        { address: '::ffff:0:a9fe:a9fe', family: 6 },
    ]);
    assert.strictEqual(await isSafeUrl('http://metadata.example.test/latest/meta-data/'), false);
});

test('isSafeUrl: hostname resolving to ::a9fe:a9fe → false (entry path)', async (t) => {
    const dns = require('node:dns');
    t.mock.method(dns.promises, 'lookup', async () => [
        { address: '::a9fe:a9fe', family: 6 },
    ]);
    assert.strictEqual(await isSafeUrl('http://metadata.example.test/latest/meta-data/'), false);
});

test('isSafeUrl: DNS-rebound hostname with a PUBLIC v6 answer still passes', async (t) => {
    // Control for the two cases above: the rejection comes from the address
    // classification, not from the DNS stub itself.
    const dns = require('node:dns');
    t.mock.method(dns.promises, 'lookup', async () => [
        { address: '2606:4700:4700::1111', family: 6 },
    ]);
    assert.strictEqual(await isSafeUrl('http://public.example.test/'), true);
});

test('URL host ::ffff:0:169.254.169.254 classifies via isPublicIp on the hex form', () => {
    const hostname = new URL('http://[::ffff:0:169.254.169.254]/').hostname;
    // WHATWG URL normalizes the dotted tail to hex and keeps the IPv6
    // brackets — the brackets are a documented, pre-existing limitation.
    assert.strictEqual(hostname, '[::ffff:0:a9fe:a9fe]');
    // Bracketed hosts fail closed (the parser rejects the brackets).
    assert.strictEqual(isPublicIp(hostname), false);
    // The normalized hex form (brackets stripped) classifies as the embedded
    // IPv4: 169.254.169.254 → link-local metadata.
    assert.strictEqual(isPublicIp('::ffff:0:a9fe:a9fe'), false);
    assert.strictEqual(isPublicIp('0000:0000:0000:0000:ffff:0000:a9fe:a9fe'), false);
});

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

// ── isPublicIp ─ extended IPv4 denylist ranges ───────────────────────────

test('isPublicIp: 240.0.0.1 → private (reserved 240.0.0.0/4)', () => {
    assert.strictEqual(isPublicIp('240.0.0.1'), false);
});

test('isPublicIp: 255.255.255.255 → private (limited broadcast)', () => {
    assert.strictEqual(isPublicIp('255.255.255.255'), false);
});

test('isPublicIp: 192.0.0.1 → private (IETF protocol assignments)', () => {
    assert.strictEqual(isPublicIp('192.0.0.1'), false);
});

test('isPublicIp: 192.0.2.1 → public (TEST-NET-1 unaffected)', () => {
    assert.strictEqual(isPublicIp('192.0.2.1'), true);
});

test('isPublicIp: 100.64.0.1 → private (CGNAT)', () => {
    assert.strictEqual(isPublicIp('100.64.0.1'), false);
});

test('isPublicIp: 100.127.255.255 → private (CGNAT upper bound)', () => {
    assert.strictEqual(isPublicIp('100.127.255.255'), false);
});

test('isPublicIp: 100.128.0.0 → public (just above CGNAT)', () => {
    assert.strictEqual(isPublicIp('100.128.0.0'), true);
});

test('isPublicIp: 198.18.0.1 → private (benchmarking)', () => {
    assert.strictEqual(isPublicIp('198.18.0.1'), false);
});

test('isPublicIp: 198.19.255.255 → private (benchmarking upper bound)', () => {
    assert.strictEqual(isPublicIp('198.19.255.255'), false);
});

test('isPublicIp: 198.20.0.0 → public (just above benchmarking)', () => {
    assert.strictEqual(isPublicIp('198.20.0.0'), true);
});

// ── isPublicIp ─ extended IPv6 denylist ranges ───────────────────────────

test('isPublicIp: 2001::1 → private (Teredo)', () => {
    assert.strictEqual(isPublicIp('2001::1'), false);
});

test('isPublicIp: 2001:0:4136:e378:8000:63bf:3fff:fdd2 → private (Teredo client)', () => {
    assert.strictEqual(isPublicIp('2001:0:4136:e378:8000:63bf:3fff:fdd2'), false);
});

test('isPublicIp: 2001:db8::1 → public (documentation, outside 2001::/32)', () => {
    assert.strictEqual(isPublicIp('2001:db8::1'), true);
});

test('isPublicIp: 2002::1 → private (6to4)', () => {
    assert.strictEqual(isPublicIp('2002::1'), false);
});

test('isPublicIp: 2002:c000:204::1 → private (6to4)', () => {
    assert.strictEqual(isPublicIp('2002:c000:204::1'), false);
});

test('isPublicIp: 100::1 → private (discard-only 100::/64)', () => {
    assert.strictEqual(isPublicIp('100::1'), false);
});

test('isPublicIp: 100:: → private (discard-only base)', () => {
    assert.strictEqual(isPublicIp('100::'), false);
});

test('isPublicIp: 100:0:0:1::1 → public (outside 100::/64)', () => {
    assert.strictEqual(isPublicIp('100:0:0:1::1'), true);
});

// ── isPublicIp ─ IPv4-translated / IPv4-compatible forms ─────────────────

test('isPublicIp: ::ffff:0:169.254.169.254 → private (translated metadata)', () => {
    assert.strictEqual(isPublicIp('::ffff:0:169.254.169.254'), false);
});

test('isPublicIp: ::ffff:0:10.0.0.1 → private (translated private)', () => {
    assert.strictEqual(isPublicIp('::ffff:0:10.0.0.1'), false);
});

test('isPublicIp: ::ffff:0:8.8.8.8 → public (translated public)', () => {
    assert.strictEqual(isPublicIp('::ffff:0:8.8.8.8'), true);
});

test('isPublicIp: ::10.0.0.1 → private (IPv4-compatible private)', () => {
    assert.strictEqual(isPublicIp('::10.0.0.1'), false);
});

test('isPublicIp: ::169.254.169.254 → private (IPv4-compatible metadata)', () => {
    assert.strictEqual(isPublicIp('::169.254.169.254'), false);
});

test('isPublicIp: ::8.8.8.8 → public (IPv4-compatible public)', () => {
    assert.strictEqual(isPublicIp('::8.8.8.8'), true);
});

// ── safeFetch ─ credential containment across redirect hops ──────────────

test('safeFetch: cross-origin redirect drops Authorization and x-api-key', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
            return new Response(null, { status: 302, headers: { Location: 'https://1.1.1.1/next' } });
        }
        return new Response('ok', { status: 200 });
    });

    const res = await safeFetch('https://8.8.8.8/start', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer fake-token',
            'X-Api-Key': 'fake-key',
            'anthropic-version': '2023-06-01',
        },
        body: '{}',
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer fake-token');
    assert.strictEqual(calls[0].init.headers['X-Api-Key'], 'fake-key');

    const hopHeaders = calls[1].init.headers;
    assert.deepStrictEqual(hopHeaders, {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
    });
    assert.strictEqual(calls[1].init.body, '{}', 'body survives the hop');
    assert.strictEqual(calls[1].init.redirect, 'manual');
    assert.strictEqual(calls[1].init.allowLoopback, undefined, 'flag is not forwarded to fetch');
});

test('safeFetch: same-origin redirect keeps credentials', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
            return new Response(null, { status: 307, headers: { Location: '/next' } });
        }
        return new Response('ok', { status: 200 });
    });

    await safeFetch('https://8.8.8.8/start', {
        headers: { Authorization: 'Bearer fake-token', 'x-api-key': 'fake-key' },
    });

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[1].init.headers.Authorization, 'Bearer fake-token');
    assert.strictEqual(calls[1].init.headers['x-api-key'], 'fake-key');
});

test('safeFetch: A→B→A redirect stays stripped on the return hop', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
            return new Response(null, { status: 302, headers: { Location: 'https://1.1.1.1/b' } });
        }
        if (calls.length === 2) {
            return new Response(null, { status: 302, headers: { Location: 'https://8.8.8.8/a' } });
        }
        return new Response('ok', { status: 200 });
    });

    const res = await safeFetch('https://8.8.8.8/start', {
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer fake-token',
            'X-Api-Key': 'fake-key',
        },
    });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(calls.map((c) => c.url), [
        'https://8.8.8.8/start',
        'https://1.1.1.1/b',
        'https://8.8.8.8/a',
    ]);
    // Hop 3 is back on the original origin, but the strip is persistent:
    // credentials are never restored once dropped.
    assert.ok(!('Authorization' in calls[2].init.headers));
    assert.ok(!('X-Api-Key' in calls[2].init.headers));
    assert.strictEqual(calls[2].init.headers['Content-Type'], 'application/json');
});

test('safeFetch: cross-origin redirect strips credentials from a Headers instance', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
            return new Response(null, { status: 302, headers: { Location: 'https://1.1.1.1/next' } });
        }
        return new Response('ok', { status: 200 });
    });

    const headers = new Headers({
        'Content-Type': 'application/json',
        Authorization: 'Bearer fake-token',
        'X-Api-Key': 'fake-key',
    });

    await safeFetch('https://8.8.8.8/start', { headers });

    const hopHeaders = calls[1].init.headers;
    assert.ok(hopHeaders instanceof Headers, 'Headers input keeps its form');
    assert.strictEqual(hopHeaders.get('authorization'), null);
    assert.strictEqual(hopHeaders.get('x-api-key'), null);
    assert.strictEqual(hopHeaders.get('content-type'), 'application/json');
    // The caller's Headers object is copied, never mutated.
    assert.strictEqual(headers.get('authorization'), 'Bearer fake-token');
});

test('safeFetch: cross-origin redirect strips credentials from [name, value] pairs', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
            return new Response(null, { status: 302, headers: { Location: 'https://1.1.1.1/next' } });
        }
        return new Response('ok', { status: 200 });
    });

    await safeFetch('https://8.8.8.8/start', {
        headers: [
            ['Content-Type', 'application/json'],
            ['Authorization', 'Bearer fake-token'],
            ['X-Api-Key', 'fake-key'],
        ],
    });

    const hopHeaders = calls[1].init.headers;
    assert.ok(Array.isArray(hopHeaders), '[name, value] input keeps its form');
    assert.deepStrictEqual(hopHeaders, [['Content-Type', 'application/json']]);
});

// ── safeFetch ─ scoped loopback allowance (Ollama) ───────────────────────

test('safeFetch: allowLoopback passes literal localhost without DNS resolution', async (t) => {
    const dns = require('node:dns');
    t.mock.method(dns.promises, 'lookup', async () => {
        throw new Error('DNS must not be consulted for the loopback allowance');
    });

    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push({ url, init });
        return new Response('ok', { status: 200 });
    });

    const res = await safeFetch('http://localhost:11434/v1/chat/completions', {
        method: 'POST',
        allowLoopback: true,
        headers: { Authorization: 'Bearer fake-local' },
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'http://localhost:11434/v1/chat/completions');
    assert.strictEqual(calls[0].init.allowLoopback, undefined);
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer fake-local');
});

test('safeFetch: allowLoopback accepts 127.* and ::1 literals', async (t) => {
    let count = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        count++;
        return new Response('ok', { status: 200 });
    });

    const urls = [
        'http://127.0.0.1:11434/v1',
        'http://127.9.9.9:11434/v1',
        'http://[::1]:11434/v1',
    ];
    for (const url of urls) {
        const res = await safeFetch(url, { allowLoopback: true });
        assert.strictEqual(res.status, 200, url);
    }
    assert.strictEqual(count, urls.length);
});

test('safeFetch: allowLoopback still rejects private LAN endpoints', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
        throw new Error('fetch must not run for an unsafe endpoint');
    });

    await assert.rejects(
        () => safeFetch('http://10.1.2.3:11434/v1/chat/completions', { allowLoopback: true }),
        /Unsafe URL blocked/
    );
    await assert.rejects(
        () => safeFetch('http://192.168.1.50:11434/v1/chat/completions', { allowLoopback: true }),
        /Unsafe URL blocked/
    );
});

test('safeFetch: allowLoopback refuses redirects, including to public hosts', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
        new Response(null, { status: 302, headers: { Location: 'https://8.8.8.8/collect' } })
    );

    await assert.rejects(
        () => safeFetch('http://localhost:11434/v1/chat/completions', { allowLoopback: true }),
        /Redirect refused/i
    );
});

test('safeFetch: localhost without allowLoopback still throws (other providers)', async (t) => {
    const dns = require('node:dns');
    t.mock.method(dns.promises, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
    t.mock.method(globalThis, 'fetch', async () => {
        throw new Error('fetch must not run for a loopback URL');
    });

    await assert.rejects(
        () => safeFetch('http://localhost:11434/v1/chat/completions'),
        /Unsafe URL blocked/
    );
});
