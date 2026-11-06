/**
 * Classify an IP address as public or as one of the ranges an outbound request
 * must never reach (plan row 23, D-045). Pure, dependency-free.
 *
 * IPv6 forms that embed an IPv4 address are unwrapped and the IPv4 part is
 * classified too: IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d),
 * NAT64 (64:ff9b::/96), 6to4 (2002::/16) and Teredo (2001::/32, client
 * address stored inverted). Anything that does not parse is refused.
 */
import { isIP } from 'node:net';

export const BLOCKED_RANGES = [
  'UNPARSEABLE',
  'UNSPECIFIED',
  'THIS_NETWORK',
  'LOOPBACK',
  'PRIVATE',
  'CGNAT',
  'LINK_LOCAL',
  'METADATA',
  'IETF_PROTOCOL',
  'DOCUMENTATION',
  'BENCHMARKING',
  'MULTICAST',
  'RESERVED',
  'BROADCAST',
  'UNIQUE_LOCAL',
  'SITE_LOCAL',
  'DISCARD',
] as const;
export type BlockedRange = (typeof BLOCKED_RANGES)[number];

export interface IpClass {
  readonly ip: string;
  readonly family: 4 | 6;
  /** null = public (routable on the internet). */
  readonly blocked: BlockedRange | null;
  /** The IPv4 address an IPv6 form embeds, when it does. */
  readonly embeddedV4: string | null;
}

interface V4Range {
  readonly base: string;
  readonly bits: number;
  readonly range: BlockedRange;
}

// Most specific first: 169.254.169.254 is METADATA before LINK_LOCAL.
const V4: readonly V4Range[] = [
  { base: '169.254.169.254', bits: 32, range: 'METADATA' },
  { base: '0.0.0.0', bits: 32, range: 'UNSPECIFIED' },
  { base: '255.255.255.255', bits: 32, range: 'BROADCAST' },
  { base: '0.0.0.0', bits: 8, range: 'THIS_NETWORK' },
  { base: '10.0.0.0', bits: 8, range: 'PRIVATE' },
  { base: '100.64.0.0', bits: 10, range: 'CGNAT' },
  { base: '127.0.0.0', bits: 8, range: 'LOOPBACK' },
  { base: '169.254.0.0', bits: 16, range: 'LINK_LOCAL' },
  { base: '172.16.0.0', bits: 12, range: 'PRIVATE' },
  { base: '192.0.0.0', bits: 24, range: 'IETF_PROTOCOL' },
  { base: '192.0.2.0', bits: 24, range: 'DOCUMENTATION' },
  { base: '192.88.99.0', bits: 24, range: 'RESERVED' },
  { base: '192.168.0.0', bits: 16, range: 'PRIVATE' },
  { base: '198.18.0.0', bits: 15, range: 'BENCHMARKING' },
  { base: '198.51.100.0', bits: 24, range: 'DOCUMENTATION' },
  { base: '203.0.113.0', bits: 24, range: 'DOCUMENTATION' },
  { base: '224.0.0.0', bits: 4, range: 'MULTICAST' },
  { base: '240.0.0.0', bits: 4, range: 'RESERVED' },
];

export function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const intToV4 = (n: number): string =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

function classifyV4(ip: string): BlockedRange | null | 'BAD' {
  const n = v4ToInt(ip);
  if (n === null) return 'BAD';
  for (const r of V4) {
    const base = v4ToInt(r.base) ?? 0;
    const size = 2 ** (32 - r.bits);
    if (n >= base && n < base + size) return r.range;
  }
  return null;
}

/** Parse an IPv6 address (with an optional dotted IPv4 tail) into a 128-bit bigint. */
export function v6ToBigInt(ip: string): bigint | null {
  let s = ip.toLowerCase();
  if (s.includes('%')) return null; // zone IDs name local interfaces: never allowed
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const v4 = v4ToInt(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === '' ? [] : h.split(':'));
  const head = parse(halves[0] ?? '');
  let groups: string[];
  if (halves.length === 2) {
    const rest = parse(halves[1] ?? '');
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array.from({ length: fill }, () => '0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

const inV6 = (n: bigint, prefix: bigint, bits: number) =>
  n >> BigInt(128 - bits) === prefix >> BigInt(128 - bits);
const p = (hex: string): bigint => v6ToBigInt(hex) ?? -1n;
const low32 = (n: bigint) => Number(n & 0xffffffffn);

export function classifyIp(input: string): IpClass {
  const ip = input.trim().replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  if (family === 4) {
    const c = classifyV4(ip);
    return { ip, family: 4, blocked: c === 'BAD' ? 'UNPARSEABLE' : c, embeddedV4: null };
  }
  if (family !== 6) return { ip, family: 6, blocked: 'UNPARSEABLE', embeddedV4: null };
  const n = v6ToBigInt(ip);
  if (n === null) return { ip, family: 6, blocked: 'UNPARSEABLE', embeddedV4: null };

  const embedded = (v4: number): IpClass => {
    const s = intToV4(v4 >>> 0);
    const c = classifyV4(s);
    return { ip, family: 6, blocked: c === 'BAD' ? 'UNPARSEABLE' : c, embeddedV4: s };
  };
  if (n === 0n) return { ip, family: 6, blocked: 'UNSPECIFIED', embeddedV4: null };
  if (n === 1n) return { ip, family: 6, blocked: 'LOOPBACK', embeddedV4: null };
  if (inV6(n, p('::ffff:0:0'), 96)) return embedded(low32(n)); // IPv4-mapped
  if (inV6(n, 0n, 96)) return embedded(low32(n)); // IPv4-compatible (deprecated)
  if (inV6(n, p('64:ff9b::'), 96)) return embedded(low32(n)); // NAT64
  if (inV6(n, p('64:ff9b:1::'), 48))
    return { ip, family: 6, blocked: 'RESERVED', embeddedV4: null };
  if (inV6(n, p('2002::'), 16)) return embedded(Number((n >> 80n) & 0xffffffffn)); // 6to4
  if (inV6(n, p('2001::'), 32)) return embedded(~low32(n) >>> 0); // Teredo client (inverted)
  if (inV6(n, p('100::'), 64)) return { ip, family: 6, blocked: 'DISCARD', embeddedV4: null };
  if (inV6(n, p('2001:db8::'), 32))
    return { ip, family: 6, blocked: 'DOCUMENTATION', embeddedV4: null };
  if (inV6(n, p('2001::'), 23))
    return { ip, family: 6, blocked: 'IETF_PROTOCOL', embeddedV4: null };
  if (inV6(n, p('fc00::'), 7)) return { ip, family: 6, blocked: 'UNIQUE_LOCAL', embeddedV4: null };
  if (inV6(n, p('fe80::'), 10)) return { ip, family: 6, blocked: 'LINK_LOCAL', embeddedV4: null };
  if (inV6(n, p('fec0::'), 10)) return { ip, family: 6, blocked: 'SITE_LOCAL', embeddedV4: null };
  if (inV6(n, p('ff00::'), 8)) return { ip, family: 6, blocked: 'MULTICAST', embeddedV4: null };
  // Only global unicast 2000::/3 is public.
  if (!inV6(n, p('2000::'), 3)) return { ip, family: 6, blocked: 'RESERVED', embeddedV4: null };
  return { ip, family: 6, blocked: null, embeddedV4: null };
}
