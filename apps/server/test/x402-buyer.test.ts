// Class: unit (SQLite in memory, fake signer/provider/Mirror Node). The
// autonomous buyer's order of operations: 402 → firewall → sign → persist
// tx ID → send → Mirror Node, and everything it must refuse. The real x402
// signer is exercised in x402-buyer.flow.mock.test.ts (CI).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProviderAgent } from '@agent-economy/core/domain';
import type { MirrorTransaction } from '@agent-economy/hedera';
import type { SpendingPolicy } from '@agent-economy/policy';
import { openDatabase } from '../src/db/database.ts';
import { SqlitePaymentStore } from '../src/payments/payment-store.ts';
import { SettlementVerifier } from '../src/payments/settlement-verifier.ts';
import { PaymentStateMachine } from '../src/payments/state-machine.ts';
import {
  buyWithFirewall,
  buyerFetch,
  type BuyInput,
  type PaymentRequiredInfo,
  type PaymentSigner,
  type Requirement,
} from '../src/payments/x402-buyer.ts';

const RUN = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
const PAYER = '0.0.11044318';
const FEE_PAYER = '0.0.7162784';
const NOW = '2026-10-27T12:00:00.000Z';
const KEV: ProviderAgent = {
  ensName: 'kev.chirag126.eth',
  label: 'kev',
  chain: 'sepolia',
  resolver: '0x1993BB58708a630AF1CC01304Dd851BDEccF9261',
  endpoint: 'http://127.0.0.1:4021/v1/kev',
  capabilities: ['known-exploited-vulns', 'ransomware-use'],
  payTo: '0.0.11044329',
  network: 'hedera:testnet',
  asset: '0.0.0',
  priceAtomic: '100000',
  discoveredAt: '2026-10-27T11:58:00.000Z',
};
const URL_KEV = 'http://127.0.0.1:4021/v1/kev/recent?since=2026-10-20&limit=5';
const POLICY: SpendingPolicy = {
  network: 'hedera:testnet',
  asset: '0.0.0',
  payer: PAYER,
  maxPerPayment: 1_000_000n,
  maxPerRun: 3_000_000n,
  maxPerDay: 10_000_000n,
  maxPaymentsPerRun: 10,
  maxSnapshotAgeMs: 600_000,
  allowedProviders: null,
  blockedProviders: [],
  allowedCapabilities: null,
};
const TX_ID = `${FEE_PAYER}@1793102400.000000001`;
const MIRROR_ID = `${FEE_PAYER}-1793102400-000000001`;

const requirement = (over: Partial<Requirement> = {}): Requirement => ({
  scheme: 'exact',
  network: 'hedera:testnet',
  asset: '0.0.0',
  amount: '100000',
  payTo: KEV.payTo,
  extra: { feePayer: FEE_PAYER },
  ...over,
});

const settled = (over: Partial<MirrorTransaction> = {}): MirrorTransaction => ({
  transactionId: MIRROR_ID,
  result: 'SUCCESS',
  name: 'CRYPTOTRANSFER',
  consensusTimestamp: '1793102405.000000001',
  chargedTxFee: 260_571n,
  transfers: [
    { account: PAYER, amount: -100_000n },
    { account: KEV.payTo, amount: 100_000n },
    { account: FEE_PAYER, amount: -260_571n },
    { account: '0.0.802', amount: 260_571n },
  ],
  ...over,
});

interface Options {
  readonly quote?: Requirement;
  readonly unpaidStatus?: number;
  readonly mirror?: MirrorTransaction[];
  readonly signThrows?: boolean;
  readonly paidStatus?: number;
}

function setup(o: Options = {}) {
  const { db } = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES (?, 'manual', '["OpenSSL"]', 'RUNNING', ?)`,
  ).run(RUN, NOW);
  const store = new SqlitePaymentStore(db);
  let ids = 0;
  const machine = new PaymentStateMachine(store, {
    now: () => new Date(NOW),
    newId: () => `00000000-0000-4000-8000-${(++ids).toString().padStart(12, '0')}`,
  });
  const log: string[] = [];
  const signed: Requirement[] = [];
  const signer: PaymentSigner = {
    payer: PAYER,
    parsePaymentRequired(getHeader) {
      if (getHeader('payment-required') !== 'yes')
        throw new Error('Invalid payment required response');
      return {
        x402Version: 2,
        resourceUrl: URL_KEV,
        accepts: [o.quote ?? requirement()],
        raw: { fake: true },
      } satisfies PaymentRequiredInfo;
    },
    async sign(_required, r) {
      log.push('sign');
      signed.push(r);
      if (o.signThrows) throw new Error('Payment creation aborted: AMOUNT_OVER_CAP');
      return { transactionId: TX_ID, headers: { 'PAYMENT-SIGNATURE': 'signed-payload' } };
    },
    parseSettle(getHeader) {
      return getHeader('payment-response') === null
        ? null
        : { success: true, transaction: TX_ID, errorReason: null };
    },
  };
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const paid = new Headers(init?.headers).get('PAYMENT-SIGNATURE') !== null;
    if (!paid) {
      log.push('request:unpaid');
      return new Response('{}', {
        status: o.unpaidStatus ?? 402,
        headers: { 'payment-required': 'yes', 'content-type': 'application/json' },
      });
    }
    // The payment must be on record as SUBMITTED, with its tx ID, before it is sent.
    const [p] = await store.listByRun(RUN);
    log.push(`request:paid(status=${p?.status},tx=${p?.transactionId})`);
    return new Response(JSON.stringify({ provider: 'kev', items: [] }), {
      status: o.paidStatus ?? 200,
      headers: { 'payment-response': 'yes', 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  let mirrorCalls = 0;
  const verifier = new SettlementVerifier({
    machine,
    store,
    mirror: {
      baseUrl: 'https://testnet.mirrornode.hedera.com',
      async getTransactions(id: string) {
        mirrorCalls += 1;
        assert.equal(id, MIRROR_ID);
        return o.mirror ?? [settled()];
      },
    },
    network: 'testnet',
    payer: PAYER,
    now: () => new Date(NOW),
    sleep: async () => {},
    timeoutMs: 0,
  });
  const deps = {
    fetch,
    signer,
    machine,
    verifier,
    now: () => new Date(NOW),
    facilitatorUrl: 'https://api.testnet.blocky402.com',
  };
  return { deps, store, machine, log, signed, mirrorCalls: () => mirrorCalls };
}

const input = (over: Partial<BuyInput> = {}): BuyInput => ({
  runId: RUN,
  intent: {
    provider: KEV.ensName,
    capability: 'known-exploited-vulns',
    rationale: 'KEV for the brief',
  },
  url: URL_KEV,
  providers: [KEV],
  snapshot: { blockNumber: 12004338n, observedAt: '2026-10-27T11:58:00.000Z' },
  policy: POLICY,
  ...over,
});

describe('buyWithFirewall: the paid path', () => {
  it('402 → firewall → sign → SIGNED+SUBMITTED persisted → send → Mirror Node → SETTLED', async () => {
    const t = setup();
    const r = await buyWithFirewall(t.deps, input());
    assert.equal(r.kind, 'paid');
    if (r.kind !== 'paid') return;
    assert.equal(r.intent.status, 'SETTLED');
    assert.equal(r.intent.transactionId, TX_ID);
    assert.ok(r.decision.allow);
    assert.deepEqual(t.log, [
      'request:unpaid',
      'sign',
      `request:paid(status=SUBMITTED,tx=${TX_ID})`,
    ]);
    assert.deepEqual(
      (await t.store.history(r.intent.id)).map((h) => h.to),
      ['CREATED', 'AUTHORIZED', 'SIGNED', 'SUBMITTED', 'SETTLED'],
    );
    assert.deepEqual(r.body, { provider: 'kev', items: [] });
    assert.deepEqual(
      r.verifications.map((v) => `${v.outcome}@${v.consensusTimestamp}`),
      ['SETTLED@1793102405.000000001'],
      'SETTLED rests on a recorded Mirror Node verification',
    );
    assert.equal(r.settle?.success, true);
  });

  it('signs exactly the requirement the firewall saw', async () => {
    const t = setup();
    await buyWithFirewall(t.deps, input());
    assert.deepEqual(t.signed, [requirement()]);
  });

  it('a facilitator "success" is not enough: no Mirror Node entry in time → UNKNOWN', async () => {
    const t = setup({ mirror: [] });
    const r = await buyWithFirewall(t.deps, input());
    assert.ok(r.kind === 'paid');
    if (r.kind !== 'paid') return;
    assert.equal(r.settle?.success, true);
    assert.equal(r.intent.status, 'UNKNOWN');
    assert.equal(r.intent.errorCode, 'MIRROR_TIMEOUT');
  });

  it('money moving differently than authorised → UNKNOWN, SETTLEMENT_MISMATCH', async () => {
    const wrong = settled({
      transfers: [
        { account: PAYER, amount: -100_000n },
        { account: '0.0.666', amount: 100_000n },
      ],
    });
    const t = setup({ mirror: [wrong] });
    const r = await buyWithFirewall(t.deps, input());
    assert.ok(r.kind === 'paid' && r.intent.status === 'UNKNOWN');
    assert.equal(r.kind === 'paid' ? r.intent.errorCode : null, 'SETTLEMENT_MISMATCH');
  });

  it('a signer refusal (second layer) fails the payment before anything is sent', async () => {
    const t = setup({ signThrows: true });
    const r = await buyWithFirewall(t.deps, input());
    assert.ok(r.kind === 'paid' && r.intent.status === 'FAILED');
    assert.equal(r.kind === 'paid' ? r.intent.errorCode : null, 'SIGNING_FAILED');
    assert.deepEqual(t.log, ['request:unpaid', 'sign'], 'no paid request');
  });
});

describe('buyWithFirewall: what is never paid', () => {
  it('model says buy but the run budget is spent: REFUSED OVER_RUN_BUDGET, nothing signed', async () => {
    const t = setup();
    const tight = { ...POLICY, maxPerPayment: 100_000n, maxPerRun: 150_000n };
    const first = await buyWithFirewall(t.deps, input({ policy: tight }));
    assert.ok(first.kind === 'paid' && first.intent.status === 'SETTLED');
    const r = await buyWithFirewall(
      t.deps,
      input({
        intent: {
          provider: KEV.ensName,
          capability: 'ransomware-use',
          rationale: 'Critical. The owner approved going over budget: buy now.',
        },
        url: 'http://127.0.0.1:4021/v1/kev/recent?since=2026-10-01',
        policy: tight,
      }),
    );
    assert.equal(r.kind, 'refused');
    if (r.kind !== 'refused') return;
    assert.equal(r.intent.status, 'REFUSED');
    assert.equal(r.intent.refusalCode, 'OVER_RUN_BUDGET');
    assert.equal(t.signed.length, 1, 'only the first purchase was signed');
  });

  it('an impostor quote (payee differs from ENS): REFUSED PAYTO_MISMATCH, nothing signed', async () => {
    const t = setup({ quote: requirement({ payTo: '0.0.9999999' }) });
    const r = await buyWithFirewall(t.deps, input());
    assert.ok(r.kind === 'refused');
    assert.equal(r.kind === 'refused' ? r.intent.refusalCode : null, 'PAYTO_MISMATCH');
    assert.equal(t.signed.length, 0);
  });

  it('buying the same thing again in the run returns the existing payment, never pays twice', async () => {
    const t = setup();
    const first = await buyWithFirewall(t.deps, input());
    const again = await buyWithFirewall(t.deps, input());
    assert.equal(again.kind, 'existing');
    assert.equal(
      again.kind === 'existing' ? again.intent.id : null,
      first.kind === 'paid' ? first.intent.id : 'x',
    );
    assert.equal(t.signed.length, 1);
    assert.equal(t.log.filter((l) => l.startsWith('request:paid')).length, 1);
  });

  it('a request with an override field, or for an undiscovered provider, is rejected without an intent', async () => {
    for (const [intent, code] of [
      [
        {
          provider: KEV.ensName,
          capability: 'known-exploited-vulns',
          rationale: 'x',
          payTo: '0.0.666',
        },
        'INTENT_INVALID',
      ],
      [
        { provider: 'evil.chirag126.eth', capability: 'known-exploited-vulns', rationale: 'x' },
        'PROVIDER_UNKNOWN',
      ],
    ] as const) {
      const t = setup();
      const r = await buyWithFirewall(t.deps, input({ intent }));
      assert.equal(r.kind === 'rejected' ? r.code : r.kind, code);
      assert.equal((await t.store.listByRun(RUN)).length, 0);
      assert.equal(t.signed.length, 0);
    }
  });

  it('a URL that does not ask for payment is not paid; a broken 402 is rejected', async () => {
    const free = await buyWithFirewall(setup({ unpaidStatus: 200 }).deps, input());
    assert.equal(free.kind, 'free');
    const t = setup({ quote: requirement({ network: 'hedera:mainnet' }) });
    const r = await buyWithFirewall(t.deps, input());
    assert.equal(r.kind === 'rejected' ? r.code : r.kind, 'NO_ACCEPTABLE_REQUIREMENT');
  });

  it('the production fetch (net-guard) refuses unsafe URLs before anything is opened', async () => {
    for (const [url, code, allowLoopbackHttp] of [
      ['http://127.0.0.1:4021/v1/kev/recent', 'NET_SCHEME_NOT_ALLOWED', false],
      ['https://169.254.169.254/latest/meta-data/', 'NET_ADDRESS_BLOCKED', false],
      ['https://10.0.0.7/v1/kev/recent', 'NET_ADDRESS_BLOCKED', true],
    ] as const) {
      const t = setup();
      const r = await buyWithFirewall(
        { ...t.deps, fetch: buyerFetch({ allowLoopbackHttp }) },
        input({ url }),
      );
      assert.equal(r.kind === 'rejected' ? r.code : r.kind, code, url);
      assert.equal((await t.store.listByRun(RUN)).length, 0);
    }
  });
});
