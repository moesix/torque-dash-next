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
 *                    (::ffff:x.x.x.x, ::ffff:0:a.b.c.d, ::a.b.c.d → classified
 *                     as the embedded IPv4)
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

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize an IP address string.
 * - IPv4-mapped / IPv4-translated / IPv4-compatible IPv6
 *   (::ffff:x.x.x.x, ::ffff:a00:5, ::ffff:0:a.b.c.d, ::a.b.c.d)
 *   → extract the embedded IPv4
 * - Returns the normalized string, or null if unparseable.
 */
function normalizeIp(ip) {
    if (typeof ip !== 'string' || !ip) return null;
    const lower = ip.trim().toLowerCase();

    // IPv4-translated (RFC 6052 /96): ::ffff:0:1.2.3.4
    const v4translated = lower.match(/^::ffff:0:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4translated) return net.isIPv4(v4translated[1]) ? v4translated[1] : null;

    // Deprecated IPv4-compatible: ::1.2.3.4
    const v4compatible = lower.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4compatible) return net.isIPv4(v4compatible[1]) ? v4compatible[1] : null;

    // IPv4-mapped IPv6: ::ffff:1.2.3.4
    const v4mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4mapped) return v4mapped[1];

    // IPv4-mapped IPv6 in hex notation: ::ffff:a00:5 / ::ffff:0a00:0005
    // The two trailing 16-bit groups encode the IPv4 address as
    // (word1 << 16) | word2 — decode into a dotted quad so the standard
    // IPv4 classification rules below apply.
    const v4mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4mappedHex) {
        const word1 = parseInt(v4mappedHex[1], 16); // high 16 bits of the IPv4
        const word2 = parseInt(v4mappedHex[2], 16); // low 16 bits
        return `${(word1 >> 8) & 0xff}.${word1 & 0xff}.${(word2 >> 8) & 0xff}.${word2 & 0xff}`;
    }

    // Plain IPv4
    if (net.isIPv4(ip)) return ip;

    // Plain IPv6
    if (net.isIPv6(ip)) return lower;

    return null;
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

/**
 * Leading hextets of an IPv6 address (everything before `::`). Missing
 * groups count as zero so compressed and expanded spellings match a prefix.
 */
function ipv6LeadingHextets(ip) {
    const head = ip.split('::')[0];
    if (!head) return [];
    return head.split(':').map((group) => parseInt(group, 16) || 0);
}

function inIpv6Prefix(ip, prefix) {
    const groups = ipv6LeadingHextets(ip);
    return prefix.every((expected, i) => (groups[i] || 0) === expected);
}

// ── isPublicIp ─────────────────────────────────────────────────────────────

function isPublicIp(ip) {
    const normalized = normalizeIp(ip);
    if (normalized === null) return false; // unparseable → fail-closed

    // IPv4 checks (including extracted IPv4 from v4-mapped v6)
    if (net.isIPv4(normalized) || normalized.indexOf('.') !== -1) {
        if (inCidr(normalized, '0.0.0.0/8')) return false;       // unspecified
        if (inCidr(normalized, '127.0.0.0/8')) return false;     // loopback
        if (inCidr(normalized, '10.0.0.0/8')) return false;      // private
        if (inCidr(normalized, '100.64.0.0/10')) return false;   // CGNAT (RFC 6598)
        if (inCidr(normalized, '169.254.0.0/16')) return false;  // link-local + metadata
        if (inCidr(normalized, '172.16.0.0/12')) return false;   // private
        if (inCidr(normalized, '192.168.0.0/16')) return false;  // private
        if (inCidr(normalized, '198.18.0.0/15')) return false;   // benchmarking
        if (inCidr(normalized, '192.0.0.0/24')) return false;    // IETF protocol assignments
        if (inCidr(normalized, '255.255.255.255/32')) return false; // limited broadcast
        if (inCidr(normalized, '240.0.0.0/4')) return false;     // reserved
        return true;
    }

    // IPv6 checks
    // :: (unspecified)
    if (normalized === '::') return false;
    // ::1 (loopback)
    if (normalized === '::1') return false;
    // fc00::/7 unique-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
    // fe80::/10 link-local (covers full /10: fe80–febf)
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
        normalized.startsWith('fea') || normalized.startsWith('feb')) return false;
    // 64:ff9b::/96 NAT64
    if (normalized.startsWith('64:ff9b:')) return false;
    // 2001::/32 Teredo
    if (inIpv6Prefix(normalized, [0x2001, 0x0])) return false;
    // 2002::/16 6to4
    if (inIpv6Prefix(normalized, [0x2002])) return false;
    // 100::/64 discard-only
    if (inIpv6Prefix(normalized, [0x100, 0x0, 0x0, 0x0])) return false;
    // ff00::/8 multicast
    if (normalized.startsWith('ff')) return false;

    return true;
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
