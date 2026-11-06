// Class: unit (SQLite in memory, fake Mirror Node). The settlement verifier:
// SETTLED only from a matching Mirror Node entry, with status, payee, payer and
// amount checked; polling and the UNKNOWN fallback; reconciliation of open
// payments; audits of SETTLED ones. Every reading is recorded.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PaymentIntent, ProviderAgent } from '@agent-economy/core/domain';
import type { MirrorTransaction } from '@agent-economy/hedera';
import { openDatabase } from '../src/db/database.ts';
import { SqlitePaymentStore } from '../src/payments/payment-store.ts';
import { SettlementVerifier } from '../src/payments/settlement-verifier.ts';
import { PaymentStateMachine } from '../src/payments/state-machine.ts';

const RUN = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
const PAYER = '0.0.11044318';
const PAYTO = '0.0.11044329';
const FEE_PAYER = '0.0.7162784';
const NOW = Date.parse('2026-10-27T13:00:00.000Z');
const TX = `${FEE_PAYER}@${NOW / 1000}.000000000`;
const MIRROR_ID = `${FEE_PAYER}-${NOW / 1000}-000000000`;
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
  discoveredAt: '2026-10-27T12:58:00.000Z',
};

const entry = (over: Partial<MirrorTransaction> = {}): MirrorTransaction => ({
  transactionId: MIRROR_ID,
  result: 'SUCCESS',
  name: 'CRYPTOTRANSFER',
  consensusTimestamp: `${NOW / 1000 + 5}.000000001`,
  chargedTxFee: 263_011n,
  tokenTransferCount: 0,
  transfers: [
    { account: PAYER, amount: -100_000n },
    { account: PAYTO, amount: 100_000n },
    { account: FEE_PAYER, amount: -263_011n },
    { account: '0.0.802', amount: 263_011n },
  ],
  ...over,
});

/** A fake Mirror Node answering `answers` in turn (the last one repeats). */
function setup(answers: MirrorTransaction[][], network: 'testnet' | 'mainnet' = 'testnet') {
  const { db } = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES (?, 'manual', '["x"]', 'RUNNING', ?)`,
  ).run(RUN, new Date(NOW).toISOString());
  let clock = NOW;
  const store = new SqlitePaymentStore(db);
  const machine = new PaymentStateMachine(store, { now: () => new Date(clock) });
  let reads = 0;
  const verifier = new SettlementVerifier({
    machine,
    store,
    mirror: {
      baseUrl: 'https://testnet.mirrornode.hedera.com',
      async getTransactions(id) {
        assert.equal(id, MIRROR_ID);
        const a = answers[Math.min(reads, answers.length - 1)] ?? [];
        reads += 1;
        return a;
      },
    },
    network,
    payer: PAYER,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    pollIntervalMs: 3_000,
    timeoutMs: 45_000,
  });
  /** An intent walked to SUBMITTED, as the buyer leaves it before verification. */
  const submitted = async (url = `${KEV.endpoint}/recent`): Promise<PaymentIntent> => {
    const { intent } = await machine.open({
      runId: RUN,
      provider: KEV,
      capability: 'known-exploited-vulns',
      requestUrl: url,
    });
    await machine.decide(intent.id, {
      allow: true,
      amount: 100_000n,
      provider: KEV,
      intent: { provider: KEV.ensName, capability: 'known-exploited-vulns', rationale: 'x' },
      runCommittedAfter: 100_000n,
      dayCommittedAfter: 100_000n,
    });
    await machine.recordSigned(intent.id, TX, 'https://api.testnet.blocky402.com');
    return machine.recordSubmitted(intent.id);
  };
  return {
    db,
    store,
    machine,
    verifier,
    submitted,
    reads: () => reads,
    elapsed: () => clock - NOW,
  };
}

describe('awaitSettlement', () => {
  it('polls until the Mirror Node has the entry, then SETTLED with the checks recorded', async () => {
    const t = setup([[], [], [entry()]]);
    const p = await t.submitted();
    const r = await t.verifier.awaitSettlement(p.id);
    assert.equal(r.outcome, 'SETTLED');
    assert.equal(r.intent.status, 'SETTLED');
    assert.equal(t.reads(), 3);
    assert.equal(t.elapsed(), 6_000);
    const [v] = r.verifications;
    assert.equal(v?.outcome, 'SETTLED');
    assert.equal(v?.mirrorNode, 'https://testnet.mirrornode.hedera.com');
    for (const name of [
      'OK transaction ID matches',
      'OK result is SUCCESS',
      'OK no token transfers',
      'OK payee credited exactly the quoted amount',
      'OK payer debited exactly the quoted amount',
      'OK reached consensus after its valid start',
    ])
      assert.ok(
        v?.checks.some((c) => c.startsWith(name)),
        name,
      );
  });

  it('no entry within the timeout: UNKNOWN (MIRROR_TIMEOUT), and the reading is recorded', async () => {
    const t = setup([[]]);
    const p = await t.submitted();
    const r = await t.verifier.awaitSettlement(p.id);
    assert.equal(r.outcome, 'UNKNOWN');
    assert.equal(r.intent.errorCode, 'MIRROR_TIMEOUT');
    assert.ok(t.elapsed() >= 45_000);
    assert.deepEqual(
      r.verifications.map((v) => v.outcome),
      ['PENDING'],
    );
  });

  it('wrong payee, wrong amount or a failed status never settles', async () => {
    const cases: [string, MirrorTransaction, string][] = [
      [
        'payee',
        entry({
          transfers: [
            { account: PAYER, amount: -100_000n },
            { account: '0.0.666', amount: 100_000n },
          ],
        }),
        'SETTLEMENT_MISMATCH',
      ],
      [
        'amount',
        entry({
          transfers: [
            { account: PAYER, amount: -10_000n },
            { account: PAYTO, amount: 10_000n },
          ],
        }),
        'SETTLEMENT_MISMATCH',
      ],
      ['tokens', entry({ tokenTransferCount: 1 }), 'SETTLEMENT_MISMATCH'],
      [
        'status',
        entry({ result: 'INSUFFICIENT_PAYER_BALANCE', transfers: [] }),
        'TX_RESULT_INSUFFICIENT_PAYER_BALANCE',
      ],
    ];
    for (const [name, e, code] of cases) {
      const t = setup([[e]]);
      const p = await t.submitted();
      const r = await t.verifier.awaitSettlement(p.id);
      assert.notEqual(r.intent.status, 'SETTLED', name);
      assert.equal(r.intent.errorCode, code, name);
      assert.equal(r.intent.status, name === 'status' ? 'FAILED' : 'UNKNOWN', name);
    }
  });

  it('a verifier pointed at another network concludes nothing', async () => {
    const t = setup([[entry()]], 'mainnet');
    const p = await t.submitted();
    const r = await t.verifier.awaitSettlement(p.id);
    assert.equal(r.intent.status, 'UNKNOWN');
    assert.equal(r.intent.errorCode, 'NETWORK_MISMATCH');
  });
});

describe('reconcileOpen and audit', () => {
  it('reconciles an UNKNOWN payment once the entry appears', async () => {
    const t = setup([[], [entry()]]);
    const p = await t.submitted();
    await t.machine.recordUnknown(p.id, 'MIRROR_TIMEOUT');
    const [first] = await t.verifier.reconcileOpen();
    assert.equal(first?.intent.status, 'UNKNOWN', 'not visible yet: stays UNKNOWN');
    const [second] = await t.verifier.reconcileOpen();
    assert.equal(second?.intent.status, 'SETTLED');
    assert.deepEqual(
      (await t.store.verifications(p.id)).map((v) => v.outcome),
      ['PENDING', 'SETTLED'],
    );
  });

  it('audits SETTLED payments against the Mirror Node now and records each reading', async () => {
    const t = setup([
      [entry()],
      [entry()],
      [
        entry({
          transfers: [
            { account: PAYER, amount: -1n },
            { account: PAYTO, amount: 1n },
          ],
        }),
      ],
    ]);
    const p = await t.submitted();
    await t.verifier.awaitSettlement(p.id);
    const [ok] = await t.verifier.audit();
    assert.equal(ok?.confirmed, true);
    const [bad] = await t.verifier.audit();
    assert.equal(bad?.confirmed, false, 'the record and the chain disagree: reported, not hidden');
    assert.equal(bad?.verification.code, 'SETTLEMENT_MISMATCH');
    assert.equal((await t.store.get(p.id))?.status, 'SETTLED', 'never un-settled');
    assert.equal((await t.store.verifications(p.id)).length, 3);
  });
});
