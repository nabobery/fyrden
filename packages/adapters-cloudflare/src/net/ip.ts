/**
 * IP address parsing and classification for the SSRF guard. Only public
 * unicast addresses are allowed; everything special-purpose is denied
 * (IANA IPv4 and IPv6 special-purpose registries).
 */

type Cidr4 = readonly [number, number];

function v4(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

const DENIED_V4: readonly Cidr4[] = [
  [v4(0, 0, 0, 0), 8], // "this network"
  [v4(10, 0, 0, 0), 8], // private
  [v4(100, 64, 0, 0), 10], // carrier-grade NAT
  [v4(127, 0, 0, 0), 8], // loopback
  [v4(169, 254, 0, 0), 16], // link-local, cloud metadata
  [v4(172, 16, 0, 0), 12], // private
  [v4(192, 0, 0, 0), 24], // IETF protocol assignments
  [v4(192, 0, 2, 0), 24], // documentation
  [v4(192, 88, 99, 0), 24], // 6to4 relay anycast
  [v4(192, 168, 0, 0), 16], // private
  [v4(198, 18, 0, 0), 15], // benchmarking
  [v4(198, 51, 100, 0), 24], // documentation
  [v4(203, 0, 113, 0), 24], // documentation
  [v4(224, 0, 0, 0), 4], // multicast
  [v4(240, 0, 0, 0), 4], // reserved, broadcast
];

export function parseIPv4(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = value * 256 + n;
  }
  return value;
}

/** Parses an IPv6 address (no brackets, no zone id) into 8 16-bit groups. */
export function parseIPv6(text: string): number[] | undefined {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return undefined;
  let tail: number[] = [];
  let body = text;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    const ip4 = parseIPv4(text.slice(lastColon + 1));
    if (ip4 === undefined) return undefined;
    tail = [ip4 >>> 16, ip4 & 0xffff];
    body = `${text.slice(0, lastColon + 1)}0`; // placeholder group, dropped below
  }
  const halves = body.split("::");
  if (halves.length > 2) return undefined;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (tail.length > 0) (rest.length > 0 ? rest : head).pop();
  const groups = [...head, ...rest].map((g) =>
    /^[0-9a-fA-F]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN,
  );
  if (groups.some(Number.isNaN)) return undefined;
  const explicit = groups.length + tail.length;
  if (halves.length === 1 && explicit !== 8) return undefined;
  if (halves.length === 2 && explicit > 7) return undefined;
  const zeros = new Array(8 - explicit).fill(0);
  const headGroups = groups.slice(0, head.length);
  const restGroups = groups.slice(head.length);
  return halves.length === 2
    ? [...headGroups, ...zeros, ...restGroups, ...tail]
    : [...groups, ...tail];
}

function inV4(ip: number, [base, bits]: Cidr4): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

export function isPublicIPv4(ip: number): boolean {
  return !DENIED_V4.some((cidr) => inV4(ip, cidr));
}

const embeddedV4 = (g: number[], from: number) =>
  (((g[from] ?? 0) << 16) >>> 0) + (g[from + 1] ?? 0);

/**
 * Allow-list, not deny-list: only global unicast 2000::/3 can be public, so
 * special-purpose ranges outside it (100::/64 discard, 100:0:0:1::/64 dummy,
 * 5f00::/16 SRv6 SIDs, fc00::/7, fe80::/10, multicast, and any future
 * assignment) are denied without being listed. Embedded IPv4 forms are
 * judged by their IPv4 address first.
 */
export function isPublicIPv6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = g;
  // IPv4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96 carry an IPv4 address.
  const prefix96Zero = g2 === 0 && g3 === 0 && g4 === 0;
  if (g0 === 0 && g1 === 0 && prefix96Zero && g5 === 0xffff) return isPublicIPv4(embeddedV4(g, 6));
  if (g0 === 0x64 && g1 === 0xff9b && prefix96Zero && g5 === 0)
    return isPublicIPv4(embeddedV4(g, 6));
  if ((g0 & 0xe000) !== 0x2000) return false; // outside global unicast 2000::/3
  // Non-global ranges inside 2000::/3.
  if (g0 === 0x2001 && g1 < 0x200) return false; // IETF protocol assignments 2001::/23, incl. Teredo
  if (g0 === 0x2001 && g1 === 0xdb8) return false; // documentation 2001:db8::/32
  if (g0 === 0x2002) return false; // 6to4 2002::/16
  if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation 3fff::/20
  return true;
}

/** True only for a syntactically valid, public unicast address. */
export function isPublicAddress(address: string): boolean {
  const ip4 = parseIPv4(address);
  if (ip4 !== undefined) return isPublicIPv4(ip4);
  const ip6 = parseIPv6(address.replace(/^\[|\]$/g, ""));
  return ip6 !== undefined && isPublicIPv6(ip6);
}
