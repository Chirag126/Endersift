import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatZg, parseNeuron, parsePriceCeil } from '../src/units.ts';

describe('0G units', () => {
  it('formats neuron exactly', () => {
    assert.equal(formatZg(0n), '0');
    assert.equal(formatZg(10n ** 18n), '1');
    assert.equal(formatZg(1_500_000_000_000_000n), '0.0015');
    assert.equal(formatZg(1n), '0.000000000000000001');
    assert.equal(formatZg(-25n * 10n ** 16n), '-0.25');
  });

  it('parses neuron amounts and flags precision loss', () => {
    assert.deepEqual(parseNeuron('123456789012345678901', 'x'), {
      neuron: 123456789012345678901n,
      exact: true,
    });
    assert.deepEqual(parseNeuron(42, 'x'), { neuron: 42n, exact: true });
    assert.equal(parseNeuron(2 ** 60, 'x').exact, false);
    for (const bad of [-1, 1.5, '1.5', '-3', '', null, {}]) {
      assert.throws(() => parseNeuron(bad, 'billing.total_cost'), /billing\.total_cost/);
    }
  });

  it('rounds prices up so cost caps stay conservative', () => {
    assert.equal(parsePriceCeil('100', 'p'), 100n);
    assert.equal(parsePriceCeil('100.000', 'p'), 100n);
    assert.equal(parsePriceCeil('100.01', 'p'), 101n);
    assert.equal(parsePriceCeil('0.5', 'p'), 1n);
    assert.equal(parsePriceCeil(0.25, 'p'), 1n);
    assert.equal(parsePriceCeil(7, 'p'), 7n);
    assert.equal(parsePriceCeil('1e5', 'p'), 100000n);
    assert.equal(parsePriceCeil('1.5e-7', 'p'), 1n);
    for (const bad of ['-1', 'abc', '-1e5', 'e5', '', null, undefined, {}, -2, Number.NaN]) {
      assert.throws(() => parsePriceCeil(bad, 'p'));
    }
  });
});
