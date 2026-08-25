// ---------------------------------------------------------------------------
// SSRF guard: exact address-space checks applied to the image URL literal.
// Covers private IPv4 (RFC 1918, CGNAT, link-local, loopback, doc/test
// ranges, multicast/reserved), IPv6 loopback/link-local/ULA/documentation/
// multicast, and IPv4-mapped IPv6 (::ffff:a.b.c.d). A DNS-rebinding hostname
// that resolves to a private address at fetch time is not covered here - use
// an egress-proxied fetch for that (noted at resolveSafeImageUrl).
// ---------------------------------------------------------------------------

/** Parses a dotted-quad IPv4 string into a 32-bit unsigned int, or null. */
function ipv4ToInt(ip: string): number | null {
    if (typeof ip !== 'string') return null;
    const octets = ip.split('.');
    if (octets.length !== 4) return null;
    let value = 0;
    for (const octet of octets) {
        if (!/^\d{1,3}$/.test(octet)) return null;
        const n = Number(octet);
        if (n > 255) return null;
        value = (value << 8) | n;
    }
    return value >>> 0;
}

/** True when an IPv4 address falls inside the given CIDR block. */
function ipv4InCidr(ip: string, cidr: string): boolean {
    const [rangeStr, prefixStr] = cidr.split('/');
    const range = ipv4ToInt(rangeStr!);
    const prefix = Number(prefixStr);
    const value = ipv4ToInt(ip);
    if (range === null || value === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32)
        return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (range & mask);
}

/** Expands an IPv6 literal into its 8 hextet strings, or null. */
function ipv6Groups(ip: string): string[] | null {
    if (typeof ip !== 'string' || !ip.includes(':')) return null;
    let s = ip.toLowerCase();
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);

    // Normalize an embedded v4 tail (e.g. ::ffff:127.0.0.1) to hextets.
    const lastColon = s.lastIndexOf(':');
    const v4Candidate = lastColon === -1 ? null : s.slice(lastColon + 1);
    if (v4Candidate && v4Candidate.includes('.')) {
        const v = ipv4ToInt(v4Candidate);
        if (v === null) return null;
        const hex = v.toString(16).padStart(8, '0');
        s = s.slice(0, lastColon + 1) + `${hex.slice(0, 4)}:${hex.slice(4)}`;
    }

    let head: string[];
    let tail: string[];
    const doubleColon = s.indexOf('::');
    if (doubleColon !== -1) {
        head = s.slice(0, doubleColon).split(':').filter(Boolean);
        tail = s
            .slice(doubleColon + 2)
            .split(':')
            .filter(Boolean);
    } else {
        head = s.split(':');
        tail = [];
    }
    if (head.length + tail.length > 8) return null;
    const missing = 8 - head.length - tail.length;
    const groups = [...head, ...Array(missing).fill('0'), ...tail].map((g) => g.padStart(4, '0'));
    if (groups.some((g) => !/^[0-9a-f]{4}$/.test(g))) return null;
    return groups;
}

/** 16 raw bytes of an IPv6 address, or null. */
function ipv6Bytes(ip: string): number[] | null {
    const groups = ipv6Groups(ip);
    if (!groups) return null;
    const bytes = [];
    for (const group of groups) {
        const n = parseInt(group, 16);
        bytes.push((n >> 8) & 0xff, n & 0xff);
    }
    return bytes;
}

/** Bit-prefix match of an IPv6 address against raw bytes + prefix length. */
function ipv6InCidr(ip: string, prefixBytes: number[], prefixBits: number): boolean {
    const bytes = ipv6Bytes(ip);
    if (!bytes) return false;
    const whole = Math.floor(prefixBits / 8);
    const rem = prefixBits % 8;
    for (let i = 0; i < whole; i++) {
        if (bytes[i] !== prefixBytes[i]) return false;
    }
    if (rem > 0) {
        const mask = (0xff << (8 - rem)) & 0xff;
        if ((bytes[whole]! & mask) !== (prefixBytes[whole]! & mask)) return false;
    }
    return true;
}

/** IPv4 private/special-use blocks (RFC 1918, 5737, 5735, 6598, 2544). */
const PRIVATE_IPV4_CIDRS = [
    '0.0.0.0/8', // this network
    '10.0.0.0/8', // private
    '100.64.0.0/10', // CGNAT
    '127.0.0.0/8', // loopback
    '169.254.0.0/16', // link-local
    '172.16.0.0/12', // private
    '192.0.0.0/24', // IETF protocol assignments
    '192.0.2.0/24', // TEST-NET-1
    '192.168.0.0/16', // private
    '198.18.0.0/15', // benchmarking
    '198.51.100.0/24', // TEST-NET-2
    '203.0.113.0/24', // TEST-NET-3
    '224.0.0.0/4', // multicast
    '240.0.0.0/4' // reserved
];

const IPV6_LOOPBACK = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
const IPV6_ULA = [0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // fc00::/7
const IPV6_DOC = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // 2001:db8::/32

/** True when the IP literal (v4 or v6) is not safely routable on the public internet. */
function isPrivateAddress(ip: string): boolean {
    const v4 = ipv4ToInt(ip);
    if (v4 !== null) {
        return PRIVATE_IPV4_CIDRS.some((cidr) => ipv4InCidr(ip, cidr));
    }

    const groups = ipv6Groups(ip);
    if (!groups) {
        // Not a valid IPv6 literal. If it contains ':' it was an attempted
        // IPv6 literal that failed to parse (malformed) => refuse. If it
        // looks like dotted-quad IPv4 (digits and dots only) it was an
        // attempted IPv4 that failed (e.g. 999.999.999.999) => refuse.
        // Hostnames without a dot (e.g. "not-an-ip" or "") are also refused
        // as unparseable. Otherwise it's a hostname (e.g. example.com) => not private.
        if (ip.includes(':')) return true;
        if (/^\d+(\.\d+){3}$/.test(ip)) return true;
        if (!ip.includes('.')) return true;
        return false;
    }

    // IPv4-mapped ::ffff:a.b.c.d -> test the embedded IPv4 against the v4 rules.
    const mapped = groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff';
    if (mapped) {
        const hi = parseInt(groups[6]!, 16);
        const lo = parseInt(groups[7]!, 16);
        return isPrivateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }

    return (
        ipv6InCidr(ip, IPV6_LOOPBACK, 128) || // ::1 (and :: itself via ::: -> "::" groups all zero; treat as private below)
        ipv6InCidr(ip, IPV6_ULA, 7) || // unique local fec0/ff00
        ipv6InCidr(ip, [0xfe, 0x80], 10) || // link-local
        ipv6InCidr(ip, IPV6_DOC, 32) || // documentation
        ipv6InCidr(ip, [0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8) || // multicast
        ipv6InCidr(ip, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96) || // NAT64 well-known prefix
        groups.every((g) => g === '0000') // ::
    );
}

/**
 * Validates that a URL is a safe, externally-reachable HTTP(S) resource.
 * Blocks SSRF attempts against private/loopback/link-local targets.
 *
 * @param {string} url The image URL
 * @returns {{ hostname: string, protocol: string } | null} Parsed URL info, or null if unsafe
 */
function resolveSafeImageUrl(url: string): { hostname: string; protocol: string } | null {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
    }
    if (parsed.hostname === 'localhost') return null;
    // Exact address-space check: private IPv4/IPv6, loopback, link-local,
    // multicast, doc ranges, IPv4-mapped forms. (DNS-rebinding where a
    // hostname resolves to a private address at fetch time is NOT covered
    // here - a proxy with its own egress is the recommended defence for
    // that attack.)
    if (isPrivateAddress(parsed.hostname)) return null;
    return { hostname: parsed.hostname, protocol: parsed.protocol };
}

export { resolveSafeImageUrl, isPrivateAddress };
