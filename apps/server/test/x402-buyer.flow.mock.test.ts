// Class: mock. The REAL Hedera payment signer (real transaction signing, x402
// spend cap, payment guard) and the REAL provider app with the x402 middleware,
// driven by the buyer, with a FAKE facilitator and a FAKE Mirror Node. Proves
// the wiring and the order of persistence; never sponsor evidence (the live
// paid call is `pnpm x402:buy`). Needs the x402 packages (CI and owner's machine).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProviderAgent } from '@agent-economy/core/domain';
import type { MirrorTransaction } from '@agent-economy/hedera';
import { generateEcdsaKey, transactionIdFromPayload } from '@agent-economy/hedera/sdk';
import { createHederaPaymentSigner, createProviderApp } from '@agent-economy/hedera/x402';
import { openDatabase } from '../src/db/database.ts';
import { SqlitePaymentStore } from '../src/payments/payment-store.ts';
import { SettlementVerifier } from '../src/payments/settlement-verifier.ts';
import { PaymentStateMachine } from '../src/payments/state-machine.ts';
import { buyWithFirewall } from '../src/payments/x402-buyer.ts';

// apps/server does not depend on @x402/* directly: derive the types from the provider app.
type Facilitator = Parameters<typeof createProviderApp>[0]['facilitator'];
type Payload = Parameters<Facilitator['settle']>[0];
type Requirements = Parameters<Facilitator['settle']>[1];

const RUN = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
const PAYER = '0.0.1001';
const PAYTO = '0.0.11044329';
const FEE_PAYER = '0.0.7162784';
const KEV: ProviderAgent = {
  ensName: 'kev.chirag126.eth',
  label: 'kev',
  chain: 'sepolia',
  resolver: '0x1993BB58708a630AF1CC01304Dd851BDEccF9261',
  endpoint: 'http://127.0.0.1:4021/v1/kev',
  capabilities: ['known-exploited-vulns'],
  payTo: PAYTO,
  network: 'hedera:testnet',
  asset: '0.0.0',
  priceAtomic: '100000',
  discoveredAt: new Date().toISOString(),
};

function setup(appPayTo = PAYTO) {
  const settledIds: string[] = [];
  const facilitator: Facilitator = {
    async getSupported() {
      return {
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'hedera:testnet',
            extra: { feePayer: FEE_PAYER },
          },
        ],
        extensions: [],
        signers: { 'hedera:*': [FEE_PAYER] },
      };
    },
    async verify() {
      return { isValid: true, payer: PAYER };
    },
    async settle(p: Payload, r: Requirements) {
      const id = transactionIdFromPayload(p.payload['transaction'] as string);
      settledIds.push(id);
      return { success: true, transaction: id, network: r.network, payer: PAYER };
    },
  };
  const app = createProviderApp({
    facilitator,
    network: 'hedera:testnet',
    label: 'kev',
    payTo: appPayTo,
    priceTinybars: 100_000n,
  });
  const { db } = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES (?, 'manual', '["x"]', 'RUNNING', ?)`,
  ).run(RUN, new Date().toISOString());
  const store = new SqlitePaymentStore(db);
  const signer = createHederaPaymentSigner({
    accountId: PAYER,
    privateKey: generateEcdsaKey().toStringRaw(),
    keyType: 'ecdsa',
    network: 'hedera:testnet',
    policy: {
      network: 'hedera:testnet',
      asset: '0.0.0',
      maxAmount: 1_000_000n,
      allowedPayTo: [PAYTO],
      payer: PAYER,
    },
  });
  const sentWith: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.headers.get('payment-signature') !== null) {
      const [p] = await store.listByRun(RUN);
      sentWith.push(`${p?.status}:${p?.transactionId}`);
    }
    return app.fetch(req);
  }) as typeof globalThis.fetch;
  const mirror = {
    async getTransactions(mirrorId: string): Promise<MirrorTransaction[]> {
      const id = settledIds.at(-1);
      if (id === undefined) return [];
      const [acct, rest] = id.split('@') as [string, string];
      const [secs, nanos] = rest.split('.') as [string, string];
      assert.equal(mirrorId, `${acct}-${secs}-${nanos}`);
      return [
        {
          transactionId: mirrorId,
          result: 'SUCCESS',
          name: 'CRYPTOTRANSFER',
          consensusTimestamp: `${Number(secs) + 2}.000000000`,
          chargedTxFee: 1n,
          transfers: [
            { account: PAYER, amount: -100_000n },
            { account: PAYTO, amount: 100_000n },
          ],
        },
      ];
    },
  };
  const machine = new PaymentStateMachine(store);
  return {
    store,
    sentWith,
    settledIds,
    deps: {
      fetch,
      signer,
      machine,
      verifier: new SettlementVerifier({
        machine,
        store,
        mirror: { baseUrl: 'https://mirror.test', ...mirror },
        network: 'testnet',
        payer: PAYER,
        sleep: async () => {},
        timeoutMs: 0,
      }),
      facilitatorUrl: 'https://api.testnet.blocky402.com',
    },
  };
}

const input = {
  runId: RUN,
  intent: { provider: KEV.ensName, capability: 'known-exploited-vulns', rationale: 'needed' },
  url: 'http://127.0.0.1:4021/v1/kev/ping',
  providers: [KEV],
  snapshot: { blockNumber: 1n, observedAt: new Date().toISOString() },
  policy: {
    network: 'hedera:testnet' as const,
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
  },
};

describe('buyer + real Hedera signer + real x402 provider app', () => {
  it('pays through the firewall, persists the tx ID before sending, and settles', async () => {
    const t = setup();
    const r = await buyWithFirewall(t.deps, input);
    assert.equal(r.kind, 'paid');
    if (r.kind !== 'paid') return;
    assert.equal(r.status, 200);
    assert.equal(r.intent.status, 'SETTLED');
    assert.equal(t.settledIds.length, 1);
    assert.equal(
      r.intent.transactionId,
      t.settledIds[0],
      'the recorded ID is the settled transaction',
    );
    assert.deepEqual(
      t.sentWith,
      [`SUBMITTED:${t.settledIds[0]}`],
      'persisted before the paid request',
    );
    assert.equal(r.settle?.transaction, t.settledIds[0]);
  });

  it('an impostor provider (payee differs from ENS) is refused before any signature', async () => {
    const t = setup('0.0.9999999');
    const r = await buyWithFirewall(t.deps, input);
    assert.equal(r.kind === 'refused' ? r.intent.refusalCode : r.kind, 'PAYTO_MISMATCH');
    assert.equal(t.settledIds.length, 0);
    assert.deepEqual(t.sentWith, []);
  });

  it('the signer refuses a requirement other than the authorised one', async () => {
    const t = setup();
    const res = await t.deps.fetch(input.url);
    const required = t.deps.signer.parsePaymentRequired(
      (n) => res.headers.get(n),
      await res.json().catch(() => undefined),
    );
    const real = required.accepts[0];
    assert.ok(real !== undefined);
    await assert.rejects(t.deps.signer.sign(required, { ...real, amount: '1' }), /NOT_AUTHORIZED/);
  });
});
