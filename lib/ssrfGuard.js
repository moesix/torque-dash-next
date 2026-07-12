/**
 * SSRF guard for user-supplied forwardUrls.
 *
 * `isSafeUrl(urlString)` returns true ONLY if the URL uses http/https AND every
 * resolved IP address is a public, routable address. It rejects:
 *   - non http/https schemes
 *   - loopback       (127.0.0.0/8, ::1)
 *   - private IPv4   (10/8, 172.16/12, 192.168/16)
 *   - link-local     (169.254/16 — INCLUDES the 169.254.169.254 cloud metadata endpoint)
 *   - private/link-local IPv6 (fc00::/7 unique-local, fe80::/10 link-local)
 *
 * DNS resolution failures are treated as unsafe.
 */
const dns = require('dns');

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

function isPublicIp(ip) {
    // IPv4
    if (ip.indexOf('.') !== -1) {
        if (inCidr(ip, '127.0.0.0/8')) return false;     // loopback
        if (inCidr(ip, '10.0.0.0/8')) return false;       // private
        if (inCidr(ip, '172.16.0.0/12')) return false;    // private
        if (inCidr(ip, '192.168.0.0/16')) return false;   // private
        if (inCidr(ip, '169.254.0.0/16')) return false;   // link-local + metadata
        return true;
    }
    // IPv6
    const v6 = ip.toLowerCase();
    if (v6 === '::1') return false;                          // loopback
    if (v6.startsWith('fc') || v6.startsWith('fd')) return false; // fc00::/7 unique-local
    if (v6.startsWith('fe80')) return false;                 // fe80::/10 link-local
    return true;
}

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

module.exports = { isSafeUrl };
