import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatHbar, parseHbar, TINYBARS_PER_HBAR } from '../src/units.ts';

describe('HBAR units', () => {
  it('formats tinybars exactly', () => {
    assert.equal(formatHbar(0n), '0');
    assert.equal(formatHbar(1n), '0.00000001');
    assert.equal(formatHbar(TINYBARS_PER_HBAR), '1');
    assert.equal(formatHbar(150_000_000n), '1.5');
    assert.equal(formatHbar(-250_000_000n), '-2.5');
    assert.equal(formatHbar(123_456_789_012n), '1234.56789012');
  });

  it('parses HBAR decimals exactly and round-trips', () => {
    assert.equal(parseHbar('2'), 200_000_000n);
    assert.equal(parseHbar('0.00000001'), 1n);
    assert.equal(parseHbar('1.5'), 150_000_000n);
    for (const v of ['0', '1', '0.1', '12.34567891']) assert.equal(formatHbar(parseHbar(v)), v);
  });

  it('rejects ambiguous or lossy input', () => {
    for (const bad of ['', '-1', '1.123456789', '1e3', 'abc', '1,5']) {
      assert.throws(() => parseHbar(bad), /non-negative decimal/);
    }
  });
});
