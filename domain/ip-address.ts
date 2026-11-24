// ---------------------------------------------------------------------------
// Whether an IP address is publicly routable — the fetch-time half of the
// SSRF gate. A public-looking name can resolve to a private address
// (127.0.0.1.nip.io, localtest.me, a rebinding name), so the name check in
// link-sources.ts is not enough on its own: the resolved address is checked
// here before a connection is made.
//
// Pure string classification, no resolution. Expects bare addresses as the
// resolver or the URL parser hands them over — no brackets, no zone index.
// ---------------------------------------------------------------------------

/** IPv4 blocks that are not public unicast space, as CIDR prefixes. */
const NON_PUBLIC_V4_BLOCKS: ReadonlyArray<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay (deprecated)
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast included
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function isPublicIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  for (const [base, prefix] of NON_PUBLIC_V4_BLOCKS) {
    const baseInt = ipv4ToInt(base)!;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((value & mask) >>> 0 === (baseInt & mask) >>> 0) return false;
  }
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped addresses reach the embedded IPv4 host — classify that.
  const mappedDotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDotted) return isPublicIpv4(mappedDotted[1]!);
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    return isPublicIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // Only global unicast (2000::/3) is public space. Everything else —
  // loopback, link-local, unique-local, site-local, multicast, unspecified,
  // NAT64, discard — stays off limits.
  if (!/^[23]/.test(lower)) return false;
  // The documentation prefix sits inside global unicast.
  return !lower.startsWith("2001:db8:");
}

/**
 * Whether the address is public unicast space — not loopback, private,
 * link-local, or any other special-use block. An unparseable address is
 * refused: a fetch must never proceed on an address it cannot classify.
 */
export function isPublicIpAddress(ip: string): boolean {
  const trimmed = ip.trim();
  if (trimmed.includes(":")) return isPublicIpv6(trimmed);
  return isPublicIpv4(trimmed);
}
