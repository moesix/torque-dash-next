/**
 * SSRF guard for outbound HTTP (custom LLM endpoints, BYOK path).
 *
 * `isSafeUrl(urlString)` returns true ONLY if the URL uses http/https AND every
 * resolved IP address is a public, routable address. It rejects:
 *   - non http/https schemes
 *   - loopback       (127.0.0.0/8, ::1)
 *   - private IPv4   (10/8, 172.16/12, 192.168/16)
 *   - link-local     (169.254/16 — INCLUDES the 169.254.169.254 cloud metadata endpoint)
 *   - unspecified    (0.0.0.0, ::)
 *   - CGNAT          (100.64.0.0/10)
 *   - benchmarking   (198.18.0.0/15)
 *   - reserved       (240.0.0.0/4, 255.255.255.255/32, 192.0.0.0/24)
 *   - private/link-local IPv6 (fc00::/7 unique-local, fe80::/10 link-local)
 *   - NAT64          (64:ff9b::/96)
 *   - Teredo         (2001::/32), 6to4 (2002::/16), discard (100::/64)
 *   - multicast      (ff00::/8)
 *   - IPv4-mapped / IPv4-translated / IPv4-compatible IPv6
 *                    (::ffff:x.x.x.x, ::ffff:a00:5, ::ffff:0:a.b.c.d, ::a.b.c.d →
 *                     classified as the embedded IPv4; hex, dotted, compressed
 *                     and fully expanded spellings all parse to the same hextets)
 *
 * `safeFetch(url, init)` wraps native `fetch` with redirect:'manual' and
 * per-hop `isSafeUrl` validation. Maximum 3 redirect hops. Credential headers
 * (`authorization`, `x-api-key`) are dropped when a redirect changes origin.
 *
 * `init.allowLoopback: true` permits literal loopback hostnames (localhost,
 * 127.*, ::1) without DNS resolution and refuses every redirect. Only the
 * local Ollama provider path sets it; no other caller may.
 *
 * DNS resolution failures are treated as unsafe.
 */
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

// ── parsing / classification ───────────────────────────────────────────────

const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/**
 * Parse an IPv6 literal into its eight 16-bit hextets.
 *
 * Handles `::` zero-fill, an embedded dotted-quad tail (`::ffff:1.2.3.4`) and
 * a `%zone` scope suffix. Returns null for anything that is not a valid IPv6
 * literal — including bracketed URL hosts (`[::1]`); callers pass bare
 * addresses, matching the pre-existing (fail-closed) bracket behavior.
 */
function parseIpv6(input) {
    if (typeof input !== 'string') return null;

    let text = input.toLowerCase();
    if (!text) return null;

    // A zone id is transport metadata, not part of the 128-bit address.
    const zoneIndex = text.indexOf('%');
    if (zoneIndex !== -1) text = text.slice(0, zoneIndex);
    if (!text || text.includes('%')) return null;

    if (text.startsWith('[') || text.endsWith(']')) return null;

    // Rewrite an embedded dotted-quad tail as two hex groups so the parser
    // only ever deals with hextets: ::ffff:1.2.3.4 → ::ffff:102:304.
    const dottedTail = text.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dottedTail) {
        if (!net.isIPv4(dottedTail[1])) return null;
        const [a, b, c, d] = dottedTail[1].split('.').map(Number);
        const hi = ((a << 8) | b).toString(16);
        const lo = ((c << 8) | d).toString(16);
        text = `${text.slice(0, dottedTail.index)}:${hi}:${lo}`;
    }
    if (text.includes('.')) return null;

    const toHextets = (part) => {
        if (part === '') return [];
        const groups = [];
        for (const group of part.split(':')) {
            if (!IPV6_GROUP.test(group)) return null;
            groups.push(parseInt(group, 16));
        }
        return groups;
    };

    const halves = text.split('::');
    if (halves.length > 2) return null;

    if (halves.length === 1) {
        const groups = toHextets(halves[0]);
        return groups !== null && groups.length === 8 ? groups : null;
    }

    const head = toHextets(halves[0]);
    const tail = toHextets(halves[1]);
    if (head === null || tail === null) return null;

    const zeroCount = 8 - head.length - tail.length;
    if (zeroCount < 1) return null; // `::` must compress at least one group
    return [...head, ...new Array(zeroCount).fill(0), ...tail];
}

/** 16 address bytes, big-endian, from eight hextets. */
function ipv6ToBytes(hextets) {
    const bytes = [];
    for (const hextet of hextets) bytes.push((hextet >> 8) & 0xff, hextet & 0xff);
    return bytes;
}

function bytesToIpv4(bytes, offset) {
    return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped / IPv4-translated /
 * IPv4-compatible IPv6 address, or null if the address is not one of them.
 *
 * Classification is on the 16 address bytes: bytes 0-9 (first 80 bits) must be
 * zero, and hextets[5] (bytes 10-11, bits 80-95) selects the form:
 *   0xffff → IPv4-mapped      ::ffff:a.b.c.d
 *   0x0000 → IPv4-compatible  ::a.b.c.d  (deprecated; includes :: and ::1)
 * The IPv4-translated block (::ffff:0:a.b.c.d, RFC 2765) instead has bytes 0-7
 * zero, bytes 8-9 = 0xffff and bytes 10-11 = 0. All three take the last 32
 * bits as the embedded IPv4 address.
 */
function embeddedIpv4(hextets) {
    const bytes = ipv6ToBytes(hextets);
    const first8Zero = bytes.slice(0, 8).every((byte) => byte === 0);
    const first10Zero = first8Zero && bytes[8] === 0 && bytes[9] === 0;

    // IPv4-mapped: ::ffff:a.b.c.d (hextets[5] = 0xffff)
    if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
        return bytesToIpv4(bytes, 12);
    }

    // IPv4-compatible: ::a.b.c.d (hextets[5] = 0x0000)
    if (first10Zero && bytes[10] === 0x00 && bytes[11] === 0x00) {
        return bytesToIpv4(bytes, 12);
    }

    // IPv4-translated: ::ffff:0:a.b.c.d
    if (first8Zero && bytes[8] === 0xff && bytes[9] === 0xff &&
        bytes[10] === 0x00 && bytes[11] === 0x00) {
        return bytesToIpv4(bytes, 12);
    }

    return null;
}

/**
 * Normalize an IP address string for classification.
 * Returns `{ family: 4, address }` or `{ family: 6, hextets }`, or null when
 * the input is not a valid IP literal (fail-closed).
 *
 * Embedded-IPv4 IPv6 forms (dotted or hex spelling, compressed or expanded)
 * resolve to family 4 so the exact same IPv4 range checks apply.
 */
function normalizeIp(ip) {
    if (typeof ip !== 'string' || !ip) return null;
    const text = ip;

    if (net.isIPv4(text)) return { family: 4, address: text };

    const hextets = parseIpv6(text);
    if (hextets === null) return null;

    const embedded = embeddedIpv4(hextets);
    if (embedded !== null) return { family: 4, address: embedded };

    return { family: 6, hextets };
}

function ipv4ToInt(ip) {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr(ip, cidr) {
    const [base, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1) >>> 0);
    return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** True when the parsed hextets start with `prefix` (hextet-aligned). */
function hasIpv6Prefix(hextets, prefix) {
    return prefix.every((expected, i) => hextets[i] === expected);
}

function isPublicIpv4(ip) {
    if (inCidr(ip, '0.0.0.0/8')) return false;       // unspecified
    if (inCidr(ip, '127.0.0.0/8')) return false;     // loopback
    if (inCidr(ip, '10.0.0.0/8')) return false;      // private
    if (inCidr(ip, '100.64.0.0/10')) return false;   // CGNAT (RFC 6598)
    if (inCidr(ip, '169.254.0.0/16')) return false;  // link-local + metadata
    if (inCidr(ip, '172.16.0.0/12')) return false;   // private
    if (inCidr(ip, '192.168.0.0/16')) return false;  // private
    if (inCidr(ip, '198.18.0.0/15')) return false;   // benchmarking
    if (inCidr(ip, '192.0.0.0/24')) return false;    // IETF protocol assignments
    if (inCidr(ip, '255.255.255.255/32')) return false; // limited broadcast
    if (inCidr(ip, '240.0.0.0/4')) return false;     // reserved
    return true;
}

function isPublicIpv6(hextets) {
    const [h0, h1, h2, h3] = hextets;

    // :: (unspecified) and ::1 (loopback) never reach here — they are caught
    // as IPv4-compatible above — but keep the explicit checks as defense.
    if (hextets.every((hextet) => hextet === 0)) return false;
    if (hextets[7] === 1 && hextets.slice(0, 7).every((hextet) => hextet === 0)) return false;
    // fc00::/7 unique-local
    if ((h0 & 0xfe00) === 0xfc00) return false;
    // fe80::/10 link-local (fe80–febf)
    if ((h0 & 0xffc0) === 0xfe80) return false;
    // ff00::/8 multicast
    if ((h0 & 0xff00) === 0xff00) return false;
    // 64:ff9b::/32 NAT64 (well-known /96 plus local-use 64:ff9b:1::/48)
    if (hasIpv6Prefix(hextets, [0x0064, 0xff9b])) return false;
    // 2001::/32 Teredo
    if (hasIpv6Prefix(hextets, [0x2001, 0x0000])) return false;
    // 2002::/16 6to4
    if (hasIpv6Prefix(hextets, [0x2002])) return false;
    // 100::/64 discard-only
    if (hasIpv6Prefix(hextets, [0x0100, 0x0000, 0x0000, 0x0000])) return false;

    return true;
}

function isPublicIp(ip) {
    const normalized = normalizeIp(ip);
    if (normalized === null) return false; // unparseable → fail-closed

    if (normalized.family === 4) return isPublicIpv4(normalized.address);
    return isPublicIpv6(normalized.hextets);
}

// ── isSafeUrl ──────────────────────────────────────────────────────────────

async function isSafeUrl(urlString) {
    if (typeof urlString !== 'string' || !urlString) return false;

    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const hostname = parsed.hostname;
    if (!hostname) return false;

    // NOTE: for IPv6 literals WHATWG URL keeps the brackets ("[::1]"), so
    // `parsed.hostname` reaches dns.lookup with them intact and isPublicIp()
    // rejects the bracketed form. This is a pre-existing limitation — bracket
    // handling is intentionally unchanged here (such URLs fail closed).
    let addresses;
    try {
        const result = await dns.promises.lookup(hostname, { all: true });
        addresses = result.map((r) => r.address);
    } catch {
        return false; // DNS resolution failure -> unsafe
    }
    if (!addresses.length) return false;

    for (const addr of addresses) {
        if (!isPublicIp(addr)) return false;
    }
    return true;
}

// ── safeFetch ──────────────────────────────────────────────────────────────

const SAFE_FETCH_MAX_HOPS = 3;

const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key']);

/**
 * Copy of `headers` without credential headers, preserving the input form
 * (plain object, Headers, or [name, value] pairs).
 */
function stripCredentialHeaders(headers) {
    if (!headers) return headers;

    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        const next = new Headers(headers);
        for (const name of [...next.keys()]) {
            if (CREDENTIAL_HEADERS.has(name.toLowerCase())) next.delete(name);
        }
        return next;
    }

    if (Array.isArray(headers)) {
        return headers.filter(([name]) => !CREDENTIAL_HEADERS.has(String(name).toLowerCase()));
    }

    if (typeof headers === 'object') {
        const next = {};
        for (const [name, value] of Object.entries(headers)) {
            if (CREDENTIAL_HEADERS.has(name.toLowerCase())) continue;
            next[name] = value;
        }
        return next;
    }

    return headers;
}

/** Literal loopback hostname — never resolved, so no DNS on the allow path. */
function isLiteralLoopbackHost(hostname) {
    if (typeof hostname !== 'string' || !hostname) return false;
    const host = hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
    return net.isIPv4(host) && host.split('.')[0] === '127';
}

async function isAllowedUrl(urlString, allowLoopback) {
    if (!allowLoopback) return isSafeUrl(urlString);

    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (isLiteralLoopbackHost(parsed.hostname)) return true;
    return isSafeUrl(urlString);
}

/**
 * Fetch wrapper that blocks SSRF:
 * - Uses redirect:'manual' to prevent auto-following
 * - Validates the initial URL + each redirect target via isSafeUrl
 * - Enforces a maximum of 3 redirect hops
 * - Drops credential headers when a redirect changes origin
 * - With `init.allowLoopback`, permits literal loopback hosts and refuses
 *   every redirect
 *
 * @param {string} url - The URL to fetch
 * @param {RequestInit & { allowLoopback?: boolean }} [init] - Options forwarded
 *   to native fetch (minus redirect/allowLoopback)
 * @returns {Promise<Response>}
 * @throws {Error} if the URL is unsafe, redirect target is unsafe, hop limit
 *   exceeded, or a loopback-allowed request is redirected
 */
async function safeFetch(url, init = {}) {
    const { redirect: _redirect, signal: callerSignal, allowLoopback = false, ...rest } = init;
    const loopbackOnly = allowLoopback === true;

    let hops = 0;
    let currentUrl = url;
    let hopInit = rest;

    while (true) {
        // Validate current URL
        if (!(await isAllowedUrl(currentUrl, loopbackOnly))) {
            throw new Error(`Unsafe URL blocked: ${currentUrl}`);
        }

        // Check if caller's abort signal has already fired
        if (callerSignal && callerSignal.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }

        const res = await fetch(currentUrl, {
            ...hopInit,
            redirect: 'manual',
            signal: callerSignal,
        });

        // Not a redirect → return as-is
        if (res.status < 300 || res.status >= 400) {
            return res;
        }

        // Loopback-allowed requests never follow a redirect.
        if (loopbackOnly) {
            throw new Error(`Redirect refused for loopback-allowed request: ${currentUrl}`);
        }

        // It's a redirect — check hop limit
        hops++;
        if (hops > SAFE_FETCH_MAX_HOPS) {
            throw new Error('Too many redirects (max 3)');
        }

        const location = res.headers.get('location');
        if (!location) {
            // No Location header on a redirect — return the redirect response
            return res;
        }

        // Resolve relative redirect against current URL
        let nextUrl;
        try {
            nextUrl = new URL(location, currentUrl).href;
        } catch {
            throw new Error(`Invalid redirect location: ${location}`);
        }

        // Origin change per hop → drop credentials (browser-equivalent semantics).
        if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
            hopInit = { ...hopInit, headers: stripCredentialHeaders(hopInit.headers) };
        }

        currentUrl = nextUrl;
    }
}

module.exports = { isPublicIp, isSafeUrl, safeFetch };
