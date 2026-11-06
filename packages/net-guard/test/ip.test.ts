// Class: unit. Every blocked range, the IPv6 forms that hide an IPv4 address, and junk input.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BLOCKED_RANGES, classifyIp, v4ToInt, v6ToBigInt } from '../src/ip.ts';

const cases: [string, string | null][] = [
  // public
  ['8.8.8.8', null],
  ['1.1.1.1', null],
  ['104.16.0.1', null],
  ['2606:4700:4700::1111', null],
  ['2001:4860:4860::8888', null],
  // IPv4 ranges
  ['0.0.0.0', 'UNSPECIFIED'],
  ['0.1.2.3', 'THIS_NETWORK'],
  ['10.0.0.1', 'PRIVATE'],
  ['10.255.255.255', 'PRIVATE'],
  ['100.64.0.1', 'CGNAT'],
  ['100.127.255.255', 'CGNAT'],
  ['100.128.0.1', null],
  ['127.0.0.1', 'LOOPBACK'],
  ['127.255.0.9', 'LOOPBACK'],
  ['169.254.169.254', 'METADATA'],
  ['169.254.1.1', 'LINK_LOCAL'],
  ['172.16.0.1', 'PRIVATE'],
  ['172.31.255.255', 'PRIVATE'],
  ['172.32.0.1', null],
  ['192.0.0.8', 'IETF_PROTOCOL'],
  ['192.0.2.1', 'DOCUMENTATION'],
  ['192.88.99.1', 'RESERVED'],
  ['192.168.1.1', 'PRIVATE'],
  ['198.18.0.1', 'BENCHMARKING'],
  ['198.19.255.255', 'BENCHMARKING'],
  ['198.51.100.7', 'DOCUMENTATION'],
  ['203.0.113.9', 'DOCUMENTATION'],
  ['224.0.0.1', 'MULTICAST'],
  ['239.255.255.250', 'MULTICAST'],
  ['240.0.0.1', 'RESERVED'],
  ['255.255.255.255', 'BROADCAST'],
  // IPv6 ranges
  ['::', 'UNSPECIFIED'],
  ['::1', 'LOOPBACK'],
  ['[::1]', 'LOOPBACK'],
  ['fc00::1', 'UNIQUE_LOCAL'],
  ['fd12:3456::1', 'UNIQUE_LOCAL'],
  ['fe80::1', 'LINK_LOCAL'],
  ['fec0::1', 'SITE_LOCAL'],
  ['ff02::1', 'MULTICAST'],
  ['2001:db8::1', 'DOCUMENTATION'],
  ['100::1', 'DISCARD'],
  ['2001:10::1', 'IETF_PROTOCOL'],
  ['4000::1', 'RESERVED'],
  ['64:ff9b:1::1', 'RESERVED'],
  // IPv4 hidden inside IPv6
  ['::ffff:127.0.0.1', 'LOOPBACK'],
  ['::ffff:7f00:1', 'LOOPBACK'],
  ['::ffff:169.254.169.254', 'METADATA'],
  ['::ffff:8.8.8.8', null],
  ['::10.0.0.1', 'PRIVATE'],
  ['64:ff9b::10.0.0.1', 'PRIVATE'],
  ['64:ff9b::808:808', null],
  ['2002:c0a8:0101::1', 'PRIVATE'],
  ['2002:a9fe:a9fe::1', 'METADATA'],
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'DOCUMENTATION'], // Teredo, client 192.0.2.45 (RFC 4380 example)
  // junk
  ['01.2.3.4', 'UNPARSEABLE'],
  ['1.2.3', 'UNPARSEABLE'],
  ['256.1.1.1', 'UNPARSEABLE'],
  ['0x7f.0.0.1', 'UNPARSEABLE'],
  ['2130706433', 'UNPARSEABLE'],
  ['fe80::1%eth0', 'UNPARSEABLE'],
  ['localhost', 'UNPARSEABLE'],
  ['', 'UNPARSEABLE'],
];

describe('classifyIp', () => {
  for (const [ip, expected] of cases) {
    it(`${ip || '(empty)'} → ${expected ?? 'public'}`, () => {
      assert.equal(classifyIp(ip).blocked, expected);
    });
  }

  it('reports the IPv4 address an IPv6 form embeds', () => {
    assert.equal(classifyIp('::ffff:127.0.0.1').embeddedV4, '127.0.0.1');
    assert.equal(classifyIp('2002:c0a8:0101::1').embeddedV4, '192.168.1.1');
    assert.equal(classifyIp('2001:0:4136:e378:8000:63bf:3fff:fdd2').embeddedV4, '192.0.2.45');
  });

  it('covers every blocked range in the table above', () => {
    const seen = new Set(cases.map(([, r]) => r));
    assert.deepEqual(
      BLOCKED_RANGES.filter((r) => !seen.has(r)),
      [],
    );
  });

  it('parses addresses exactly', () => {
    assert.equal(v4ToInt('192.168.1.1'), 0xc0a80101);
    assert.equal(v4ToInt('1.2.3.04'), null);
    assert.equal(v6ToBigInt('::ffff:1.2.3.4'), 0xffff01020304n);
    assert.equal(v6ToBigInt('1::2::3'), null);
    assert.equal(v6ToBigInt('1:2:3:4:5:6:7:8:9'), null);
  });
});
