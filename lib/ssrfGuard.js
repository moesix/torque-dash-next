/**
 * SSRF guard for user-supplied forwardUrls.
 *
 * `isSafeUrl(urlString)` returns true ONLY if the URL uses http/https AND every
 * resolved IP address is a public, routable address. It rejects:
 *   - non http/https schemes
 *   - loopback       (127.0.0.0/8, ::1)
 *   - private IPv4   (10/8, 172.16/12, 192.168/16)
 *   - link-local     (169.254/16 — INCLUDES the 169.254.169.254 cloud metadata endpoint)
 *   - unspecified    (0.0.0.0, ::)
 *   - private/link-local IPv6 (fc00::/7 unique-local, fe80::/10 link-local)
 *   - NAT64          (64:ff9b::/96)
 *   - multicast      (ff00::/8)
 *   - IPv4-mapped    (::ffff:x.x.x.x → classified as the embedded IPv4)
 *
 * `safeFetch(url, init)` wraps native `fetch` with redirect:'manual' and
 * per-hop `isSafeUrl` validation. Maximum 3 redirect hops.
 *
 * DNS resolution failures are treated as unsafe.
 */
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Normalize an IP address string.
 * - IPv4-mapped IPv6 (::ffff:x.x.x.x) → extract the embedded IPv4
 * - Returns the normalized string, or null if unparseable.
 */
function normalizeIp(ip) {
    if (typeof ip !== 'string' || !ip) return null;
    const lower = ip.trim().toLowerCase();

    // IPv4-mapped IPv6: ::ffff:1.2.3.4
    const v4mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4mapped) return v4mapped[1];

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

/**
 * Fetch wrapper that blocks SSRF:
 * - Uses redirect:'manual' to prevent auto-following
 * - Validates the initial URL + each redirect target via isSafeUrl
 * - Enforces a maximum of 3 redirect hops
 *
 * @param {string} url - The URL to fetch
 * @param {RequestInit} [init] - Options forwarded to native fetch (minus redirect)
 * @returns {Promise<Response>}
 * @throws {Error} if the URL is unsafe, redirect target is unsafe, or hop limit exceeded
 */
async function safeFetch(url, init = {}) {
    const { redirect: _redirect, signal: callerSignal, ...rest } = init;

    let hops = 0;
    let currentUrl = url;

     
    while (true) {
        // Validate current URL
        if (!(await isSafeUrl(currentUrl))) {
            throw new Error(`Unsafe URL blocked: ${currentUrl}`);
        }

        // Check if caller's abort signal has already fired
        if (callerSignal && callerSignal.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }

        const res = await fetch(currentUrl, {
            ...rest,
            redirect: 'manual',
            signal: callerSignal,
        });

        // Not a redirect → return as-is
        if (res.status < 300 || res.status >= 400) {
            return res;
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

        currentUrl = nextUrl;
    }
}

module.exports = { isPublicIp, isSafeUrl, safeFetch };
