// Class: mock. The REAL Hono app with the NEAR pay lane on, a FAKE guard
// contract (receipts in memory) and FAKE upstream feeds. Proves the lane's
// wiring: quote, payment check, single use. Never sponsor evidence.
// CI only (needs hono and the @x402 packages the app imports).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NEAR_PAYMENT_HEADER,
  parseNear,
  parseQuote,
  paymentHeader,
  type GuardReceipt,
} from '@agent-economy/near';
import type { FacilitatorClient } from '@x402/core/server';
import { createIntelApp } from '../src/app.ts';
import { KevFeed } from '../src/feeds/kev.ts';
import { NvdClient } from '../src/feeds/nvd.ts';
import { OsvClient } from '../src/feeds/osv.ts';
import { KEV_FIXTURE, OSV_FIXTURE } from './fixtures.ts';

const BASE = 'http://127.0.0.1:4021';
const GUARD = 'guard.endersift.testnet';
const KEV = 'kev.endersift.testnet';
const PRICE = parseNear('0.001');
const ROUTE = '/near/v1/kev/recent?since=2099-01-01&limit=10';

const facilitator: FacilitatorClient = {
  async getSupported() {
    return {
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'hedera:testnet',
          extra: { feePayer: '0.0.7162784' },
        },
      ],
      extensions: [],
      signers: { 'hedera:*': ['0.0.7162784'] },
    };
  },
  async verify() {
    throw new Error('the NEAR lane must not call the x402 facilitator');
  },
  async settle() {
    throw new Error('the NEAR lane must not call the x402 facilitator');
  },
};

function setup(options: { upstreamDown?: boolean; guardDown?: boolean } = {}) {
  const receipts = new Map<number, GuardReceipt>();
  const state = { upstreamDown: options.upstreamDown === true, nonces: 0 };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const kevFetch = (async () =>
    state.upstreamDown ? new Response('down', { status: 500 }) : ok(KEV_FIXTURE)) as typeof fetch;
  const app = createIntelApp({
    facilitators: facilitator,
    network: 'hedera:testnet',
    providers: [
      { label: 'kev', payTo: '0.0.11044329', priceAtomic: '100000' },
      { label: 'osv', payTo: '0.0.11183142', priceAtomic: '120000' },
    ],
    now: () => new Date('2099-01-15T12:00:00.000Z'),
    feeds: {
      kev: new KevFeed({ fetch: kevFetch }),
      nvd: new NvdClient({ fetch: (async () => ok({})) as typeof fetch }),
      osv: new OsvClient({ fetch: (async () => ok(OSV_FIXTURE)) as typeof fetch }),
    },
    near: {
      network: 'near:testnet',
      guard: GUARD,
      priceYocto: PRICE,
      // osv has no NEAR account: it stays off the NEAR lane
      accounts: { kev: KEV },
      receipt: async (id) => {
        if (options.guardDown === true) throw new Error('rpc down');
        return receipts.get(id) ?? null;
      },
      nonce: () => (state.nonces += 1).toString(16).padStart(32, '0'),
    },
  });
  const get = (path: string, payment?: string) =>
    app.fetch(
      new Request(`${BASE}${path}`, {
        headers: payment === undefined ? {} : { [NEAR_PAYMENT_HEADER]: payment },
      }),
    );
  const pay = (id: number, nonce: string, over: Partial<GuardReceipt> = {}) =>
    receipts.set(id, {
      id,
      runId: 'run-1',
      receiver: KEV,
      amount: PRICE,
      memo: nonce,
      status: 'Paid',
      passed: null,
      atMs: 1,
      ...over,
    });
  return { get, pay, state };
}

async function quoteOf(res: Response) {
  assert.equal(res.status, 402);
  return parseQuote(await res.json());
}

describe('NEAR pay lane', () => {
  it('describes the operation and its NEAR price for free', async () => {
    const { get } = setup();
    const desc = (await (await get('/near/v1/kev')).json()) as {
      operations: { path: string; payment: Record<string, string> }[];
    };
    assert.equal(desc.operations[0]?.path, '/near/v1/kev/recent');
    assert.deepEqual(desc.operations[0]?.payment, {
      scheme: 'near-guard',
      network: 'near:testnet',
      guard: GUARD,
      amount: PRICE.toString(),
      payTo: KEV,
    });
    const health = (await (await get('/health')).json()) as { nearLane: boolean };
    assert.equal(health.nearLane, true);
    assert.equal((await get('/near/v1/osv')).status, 404);
  });

  it('quotes an unpaid request and serves it once the guard receipt pays the quote', async () => {
    const { get, pay } = setup();
    const quote = await quoteOf(await get(ROUTE));
    assert.equal(quote.payTo, KEV);
    assert.equal(quote.guard, GUARD);
    assert.equal(quote.amount, PRICE);
    pay(7, quote.nonce);
    const res = await get(ROUTE, paymentHeader(quote.nonce, 7));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { provider: string; items: unknown[] };
    assert.equal(body.provider, 'kev');
    assert.ok(Array.isArray(body.items));
    // single use: the same payment does not buy a second answer
    assert.equal((await get(ROUTE, paymentHeader(quote.nonce, 7))).status, 402);
  });

  it('never prices a malformed request', async () => {
    const { get } = setup();
    assert.equal((await get('/near/v1/kev/recent?since=not-a-date')).status, 400);
  });

  it('refuses a receipt that does not pay this quote', async () => {
    const { get, pay } = setup();
    const quote = await quoteOf(await get(ROUTE));
    const tryWith = async (id: number, over: Partial<GuardReceipt>) => {
      pay(id, quote.nonce, over);
      const res = await get(ROUTE, paymentHeader(quote.nonce, id));
      assert.equal(res.status, 402);
      return ((await res.json()) as { error: string }).error;
    };
    assert.match(await tryWith(1, { receiver: 'cve.endersift.testnet' }), /another account/);
    assert.match(await tryWith(2, { amount: PRICE - 1n }), /less than the price/);
    assert.match(await tryWith(3, { status: 'Failed' }), /failed/);
    assert.match(await tryWith(4, { memo: 'f'.repeat(32) }), /another quote/);
    // a receipt that does not exist, and a quote issued for another request
    assert.equal((await get(ROUTE, paymentHeader(quote.nonce, 99))).status, 402);
    pay(5, quote.nonce);
    const other = '/near/v1/kev/recent?since=2099-01-02&limit=10';
    assert.equal((await get(other, paymentHeader(quote.nonce, 5))).status, 402);
    assert.equal((await get(ROUTE, 'garbage')).status, 402);
  });

  it('keeps a paid quote valid when the upstream feed fails, so the buyer can ask again', async () => {
    const { get, pay, state } = setup({ upstreamDown: true });
    const quote = await quoteOf(await get(ROUTE));
    pay(7, quote.nonce);
    const failed = await get(ROUTE, paymentHeader(quote.nonce, 7));
    assert.ok(failed.status >= 500);
    state.upstreamDown = false;
    assert.equal((await get(ROUTE, paymentHeader(quote.nonce, 7))).status, 200);
  });

  it('answers 503 when the guard contract cannot be read', async () => {
    const { get } = setup({ guardDown: true });
    const quote = await quoteOf(await get(ROUTE));
    assert.equal((await get(ROUTE, paymentHeader(quote.nonce, 1))).status, 503);
  });
});
