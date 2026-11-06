// Class: unit. The shared x402 server module: route validation, facilitator
// list from env, and the startup probe. CI only (imports the @x402 packages).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FacilitatorClient } from '@x402/core/server';
import {
  PaymentConfigError,
  facilitatorsFromEnv,
  paymentRoutes,
  probeFacilitators,
} from '../src/x402-server.ts';

const fake = (behaviour: 'ok' | 'down' | 'no-hedera' | 'bad-fee-payer'): FacilitatorClient =>
  ({
    async getSupported() {
      if (behaviour === 'down') throw new Error('fetch failed\nstack');
      const network = behaviour === 'no-hedera' ? 'eip155:84532' : 'hedera:testnet';
      const feePayer = behaviour === 'bad-fee-payer' ? '0xabc' : '0.0.7162784';
      return {
        kinds: [{ x402Version: 2, scheme: 'exact', network, extra: { feePayer } }],
        extensions: [],
        signers: {},
      };
    },
  }) as unknown as FacilitatorClient;

describe('paymentRoutes', () => {
  it('builds exact HBAR routes keyed by GET path', () => {
    const routes = paymentRoutes('hedera:testnet', [
      { path: '/v1/kev/recent', priceAtomic: '100000', payTo: '0.0.11044329', description: 'kev' },
    ]);
    assert.deepEqual(Object.keys(routes), ['GET /v1/kev/recent']);
    const accepts = routes['GET /v1/kev/recent']?.accepts as {
      price: unknown;
      payTo: string;
      scheme: string;
    };
    assert.deepEqual(accepts.price, { amount: '100000', asset: '0.0.0' });
    assert.equal(accepts.payTo, '0.0.11044329');
    assert.equal(accepts.scheme, 'exact');
  });

  it('refuses bad prices, payees, assets, paths and duplicates', () => {
    const base = { path: '/v1/x', priceAtomic: '1', payTo: '0.0.1', description: 'x' };
    for (const bad of [
      { ...base, priceAtomic: '0' },
      { ...base, priceAtomic: '1.5' },
      { ...base, payTo: '0xabc' },
      { ...base, asset: 'HBAR' },
      { ...base, path: 'v1/x' },
      { ...base, path: '/v1/x?y=1' },
    ]) {
      assert.throws(
        () => paymentRoutes('hedera:testnet', [bad]),
        PaymentConfigError,
        JSON.stringify(bad),
      );
    }
    assert.throws(() => paymentRoutes('hedera:testnet', [base, base]), /duplicate/);
  });
});

describe('facilitators from env', () => {
  it('orders primary before fallback, normalises URLs and drops an empty or duplicate fallback', () => {
    const made: string[] = [];
    const make = (url: string) => {
      made.push(url);
      return fake('ok');
    };
    const two = facilitatorsFromEnv('https://a.example/', ' https://b.example ', make);
    assert.deepEqual(
      two.map((e) => `${e.role}:${e.url}`),
      ['primary:https://a.example', 'fallback:https://b.example'],
    );
    assert.equal(facilitatorsFromEnv('https://a.example', '', make).length, 1);
    assert.equal(facilitatorsFromEnv('https://a.example', undefined, make).length, 1);
    assert.equal(facilitatorsFromEnv('https://a.example', 'https://a.example/', make).length, 1);
    assert.deepEqual(made.slice(0, 2), ['https://a.example', 'https://b.example']);
  });

  it('probes in order and reports the facilitator x402 will bind', async () => {
    const entries = (p: Parameters<typeof fake>[0], f: Parameters<typeof fake>[0]) => [
      { role: 'primary' as const, url: 'https://a.example', client: fake(p) },
      { role: 'fallback' as const, url: 'https://b.example', client: fake(f) },
    ];
    assert.equal(
      (await probeFacilitators(entries('ok', 'ok'), 'hedera:testnet')).bound?.role,
      'primary',
    );
    const fallback = await probeFacilitators(entries('down', 'ok'), 'hedera:testnet');
    assert.equal(fallback.bound?.role, 'fallback');
    assert.equal(fallback.probes[0]?.error, 'fetch failed', 'first line only');
    assert.equal(
      (await probeFacilitators(entries('no-hedera', 'bad-fee-payer'), 'hedera:testnet')).bound,
      null,
    );
    const none = await probeFacilitators(entries('no-hedera', 'down'), 'hedera:testnet');
    assert.match(none.probes[0]?.error ?? '', /does not support exact on hedera:testnet/);
  });
});
