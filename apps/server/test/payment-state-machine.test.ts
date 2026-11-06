// Class: unit (SQLite in memory). The payment state machine: every
// transition (allowed and refused, in code and in the database), idempotent
// intents, no re-sign from UNKNOWN, Mirror Node reconciliation and the
// firewall's spend state. Uses the real kev agent record.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PAYMENT_TRANSITIONS,
  PaymentStatus,
  type PaymentIntent,
  type ProviderAgent,
} from '@agent-economy/core/domain';
import type { MirrorTransaction } from '@agent-economy/hedera';
import { authorize, type Decision } from '@agent-economy/policy';
import { openDatabase } from '../src/db/database.ts';
import {
  SqlitePaymentStore,
  StaleTransitionError,
  type SettlementVerification,
} from '../src/payments/payment-store.ts';
import {
  PaymentStateError,
  PaymentStateMachine,
  paymentIdempotencyKey,
} from '../src/payments/state-machine.ts';

const RUN = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
const PAYER = '0.0.11044318';
const FEE_PAYER = '0.0.7162784';
const FACILITATOR = 'https://api.testnet.blocky402.com';
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
  discoveredAt: '2026-10-27T09:50:48.000Z',
};
const URL_A = 'http://127.0.0.1:4021/v1/kev/recent?since=2026-10-20&limit=5';

function setup(start = '2026-10-27T10:00:00.000Z') {
  const { db } = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES (?, 'manual', '["OpenSSL"]', 'RUNNING', ?)`,
  ).run(RUN, start);
  let now = Date.parse(start);
  let n = 0;
  const store = new SqlitePaymentStore(db);
  const sm = new PaymentStateMachine(store, {
    now: () => new Date(now),
    newId: () => `00000000-0000-4000-8000-${(++n).toString().padStart(12, '0')}`,
  });
  return {
    db,
    store,
    sm,
    advance: (sec: number) => {
      now += sec * 1000;
    },
    nowIso: () => new Date(now).toISOString(),
    /** A transaction ID whose valid start is `now`, as the signer would make it. */
    txIdNow: () => {
      const secs = Math.floor(now / 1000);
      return `${FEE_PAYER}@${secs}.${String(now % 1000).padEnd(9, '0')}`;
    },
  };
}

const allow = (p: Pick<PaymentIntent, 'capability'>, provider = KEV): Decision => ({
  allow: true,
  amount: BigInt(provider.priceAtomic),
  provider,
  intent: { provider: provider.ensName, capability: p.capability, rationale: 'needed' },
  runCommittedAfter: BigInt(provider.priceAtomic),
  dayCommittedAfter: BigInt(provider.priceAtomic),
});

const mirrorFor = (txId: string, over: Partial<MirrorTransaction> = {}): MirrorTransaction => {
  const [acct, rest] = txId.split('@') as [string, string];
  const [secs, nanos] = rest.split('.') as [string, string];
  return {
    transactionId: `${acct}-${secs}-${nanos}`,
    result: 'SUCCESS',
    name: 'CRYPTOTRANSFER',
    consensusTimestamp: `${secs}.000000001`,
    chargedTxFee: 84_000n,
    transfers: [
      { account: PAYER, amount: -100_000n },
      { account: KEV.payTo, amount: 100_000n },
      { account: FEE_PAYER, amount: -84_000n },
      { account: '0.0.98', amount: 84_000n },
    ],
    ...over,
  };
};

/** Open a fresh intent and walk it to `status` along allowed edges. */
async function at(t: ReturnType<typeof setup>, status: PaymentStatus, url = URL_A) {
  const { intent } = await t.sm.open({
    runId: RUN,
    provider: KEV,
    capability: 'known-exploited-vulns',
    requestUrl: url,
  });
  const id = intent.id;
  const tx = t.txIdNow();
  const path: Record<PaymentStatus, (() => Promise<unknown>)[]> = {
    CREATED: [],
    REFUSED: [
      () =>
        t.sm.decide(id, {
          allow: false,
          code: 'OVER_RUN_BUDGET',
          reason: 'x',
          violations: [{ code: 'OVER_RUN_BUDGET', detail: 'x' }],
        }),
    ],
    AUTHORIZED: [() => t.sm.decide(id, allow(intent))],
    SIGNED: [() => t.sm.decide(id, allow(intent)), () => t.sm.recordSigned(id, tx, FACILITATOR)],
    SUBMITTED: [
      () => t.sm.decide(id, allow(intent)),
      () => t.sm.recordSigned(id, tx, FACILITATOR),
      () => t.sm.recordSubmitted(id),
    ],
    UNKNOWN: [
      () => t.sm.decide(id, allow(intent)),
      () => t.sm.recordSigned(id, tx, FACILITATOR),
      () => t.sm.recordSubmitted(id),
      () => t.sm.recordUnknown(id, 'MIRROR_TIMEOUT'),
    ],
    SETTLED: [
      () => t.sm.decide(id, allow(intent)),
      () => t.sm.recordSigned(id, tx, FACILITATOR),
      () => t.sm.recordSubmitted(id),
      () => t.sm.reconcile(id, [mirrorFor(tx)], PAYER),
    ],
    FAILED: [
      () => t.sm.decide(id, allow(intent)),
      () => t.sm.recordFailedBeforeSubmit(id, 'NEVER_SENT'),
    ],
  };
  for (const step of path[status]) await step();
  const p = await t.store.get(id);
  assert.equal(p?.status, status);
  return p as PaymentIntent;
}

/** Patch a transition into `to` needs to be valid in the domain. */
const patchFor = (to: PaymentStatus, t: ReturnType<typeof setup>) => ({
  ...(to === 'SIGNED' ? { transactionId: t.txIdNow(), facilitator: FACILITATOR } : {}),
  ...(to === 'REFUSED' ? { refusalCode: 'OVER_RUN_BUDGET' } : {}),
  ...(to === 'SETTLED' ? { settledAt: t.nowIso() } : {}),
});

const STATUSES = PaymentStatus.options;

/** A SETTLED Mirror Node verification for `p` (what the verifier writes before settling). */
const verified = (p: PaymentIntent): SettlementVerification => ({
  id: `v-${p.id}`,
  paymentId: p.id,
  transactionId: p.transactionId ?? '',
  mirrorNode: 'https://testnet.mirrornode.hedera.com',
  outcome: 'SETTLED',
  code: null,
  consensusTimestamp: '1793102405.000000001',
  checks: ['OK test'],
  entries: 1,
  verifiedAt: '2026-10-27T10:00:00.000Z',
});

describe('every transition', () => {
  it('allows exactly the 11 edges of PAYMENT_TRANSITIONS and logs each one', async () => {
    let allowed = 0;
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to) continue;
        const t = setup();
        const p = await at(t, from);
        const legal = PAYMENT_TRANSITIONS[from].includes(to);
        const attempt = t.store.transition({
          id: p.id,
          from,
          to,
          patch: patchFor(to, t),
          detail: {},
          at: t.nowIso(),
          ...(to === 'SETTLED' ? { verification: verified(p) } : {}),
        });
        if (legal) {
          const after = await attempt;
          assert.equal(after.status, to, `${from} → ${to}`);
          const log = await t.store.history(p.id);
          assert.deepEqual(log.at(-1) && [log.at(-1)?.from, log.at(-1)?.to], [from, to]);
          allowed += 1;
        } else {
          await assert.rejects(attempt, /illegal payment transition/, `${from} → ${to}`);
          assert.equal((await t.store.get(p.id))?.status, from, 'unchanged');
        }
      }
    }
    assert.equal(allowed, 11);
  });

  it('the database refuses every illegal edge on its own (raw SQL, no code checks)', async () => {
    let refused = 0;
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to || PAYMENT_TRANSITIONS[from].includes(to)) continue;
        const t = setup();
        const p = await at(t, from);
        assert.throws(
          () =>
            t.db
              .prepare(
                'UPDATE payment_intents SET status = ?, settled_at = ?, refusal_code = ?, transaction_id = COALESCE(transaction_id, ?) WHERE id = ?',
              )
              .run(to, t.nowIso(), 'X_CODE', t.txIdNow(), p.id),
          // CREATED → SETTLED etc. may also trip the "SETTLED needs a verification" trigger first
          /illegal payment status transition|SETTLED only after a Mirror Node verification/,
          `${from} → ${to}`,
        );
        refused += 1;
      }
    }
    assert.equal(refused, 8 * 7 - 11);
  });

  it('records the whole history of a settled payment in order', async () => {
    const t = setup();
    const p = await at(t, 'SETTLED');
    const log = await t.store.history(p.id);
    assert.deepEqual(
      log.map((e) => `${e.from ?? '-'}>${e.to}`),
      [
        '->CREATED',
        'CREATED>AUTHORIZED',
        'AUTHORIZED>SIGNED',
        'SIGNED>SUBMITTED',
        'SUBMITTED>SETTLED',
      ],
    );
    assert.ok(p.settledAt !== null);
  });
});

describe('idempotency', () => {
  it('opening the same purchase twice returns the same intent', async () => {
    const t = setup();
    const a = await t.sm.open({
      runId: RUN,
      provider: KEV,
      capability: 'known-exploited-vulns',
      requestUrl: URL_A,
    });
    const b = await t.sm.open({
      runId: RUN,
      provider: KEV,
      capability: 'known-exploited-vulns',
      requestUrl: 'http://127.0.0.1:4021/v1/kev/recent?limit=5&since=2026-10-20', // same query, other order
    });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.intent.id, a.intent.id);
    assert.equal((await t.store.listByRun(RUN)).length, 1);
  });

  it('a retry after an UNKNOWN outcome gets the UNKNOWN intent back, not a new payment', async () => {
    const t = setup();
    const p = await at(t, 'UNKNOWN');
    const again = await t.sm.open({
      runId: RUN,
      provider: KEV,
      capability: 'known-exploited-vulns',
      requestUrl: URL_A,
    });
    assert.equal(again.created, false);
    assert.equal(again.intent.id, p.id);
    assert.equal(again.intent.status, 'UNKNOWN');
  });

  it('a different URL, capability or run is a different purchase', () => {
    const base = {
      runId: RUN,
      provider: KEV.ensName,
      capability: 'known-exploited-vulns',
      requestUrl: URL_A,
    };
    const k = paymentIdempotencyKey(base);
    assert.match(k, /^[0-9a-f]{64}$/);
    assert.notEqual(
      paymentIdempotencyKey({ ...base, requestUrl: `${KEV.endpoint}/recent?limit=6` }),
      k,
    );
    assert.notEqual(paymentIdempotencyKey({ ...base, capability: 'ransomware-use' }), k);
    assert.notEqual(
      paymentIdempotencyKey({ ...base, runId: '1b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a' }),
      k,
    );
  });
});

describe('no re-sign', () => {
  it('an UNKNOWN payment can never be signed again (code, then database)', async () => {
    const t = setup();
    const p = await at(t, 'UNKNOWN');
    await assert.rejects(
      t.sm.recordSigned(p.id, t.txIdNow(), FACILITATOR),
      (e: unknown) => e instanceof PaymentStateError && e.code === 'ALREADY_SIGNED',
    );
    assert.throws(
      () => t.db.prepare("UPDATE payment_intents SET status = 'SIGNED' WHERE id = ?").run(p.id),
      /illegal payment status transition/,
    );
    assert.throws(
      () =>
        t.db
          .prepare("UPDATE payment_intents SET transaction_id = '0.0.1@1.000000001' WHERE id = ?")
          .run(p.id),
      /cannot change/,
    );
  });

  it('nothing that was ever signed, or that is not AUTHORIZED, can be signed', async () => {
    for (const [status, code] of [
      ['SIGNED', 'ALREADY_SIGNED'],
      ['SUBMITTED', 'ALREADY_SIGNED'],
      ['SETTLED', 'ALREADY_SIGNED'],
      ['CREATED', 'NOT_SIGNABLE'],
      ['REFUSED', 'NOT_SIGNABLE'],
      ['FAILED', 'NOT_SIGNABLE'],
    ] as const) {
      const t = setup();
      const p = await at(t, status);
      await assert.rejects(
        t.sm.recordSigned(p.id, t.txIdNow(), FACILITATOR),
        (e: unknown) => e instanceof PaymentStateError && e.code === code,
        status,
      );
    }
  });

  it('two signers racing on one AUTHORIZED payment: exactly one wins', async () => {
    const t = setup();
    const p = await at(t, 'AUTHORIZED');
    const results = await Promise.allSettled([
      t.sm.recordSigned(p.id, `${FEE_PAYER}@1793100000.000000001`, FACILITATOR),
      t.sm.recordSigned(p.id, `${FEE_PAYER}@1793100000.000000002`, FACILITATOR),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const loser = results.find((r) => r.status === 'rejected');
    assert.ok(
      loser?.status === 'rejected' &&
        (loser.reason instanceof StaleTransitionError || loser.reason instanceof PaymentStateError),
    );
    assert.equal((await t.store.get(p.id))?.transactionId, `${FEE_PAYER}@1793100000.000000001`);
  });

  it('after submission only a Mirror Node verdict can fail a payment', async () => {
    for (const status of ['SUBMITTED', 'UNKNOWN'] as const) {
      const t = setup();
      const p = await at(t, status);
      await assert.rejects(
        t.sm.recordFailedBeforeSubmit(p.id, 'X_ERR'),
        (e: unknown) => e instanceof PaymentStateError && e.code === 'NEEDS_MIRROR_VERDICT',
      );
    }
  });
});

describe('firewall decision', () => {
  it('REFUSED keeps the firewall code; an ALLOW for another purchase is refused, not authorised', async () => {
    const t = setup();
    const refused = await at(t, 'REFUSED');
    assert.equal(refused.refusalCode, 'OVER_RUN_BUDGET');
    const t2 = setup();
    const { intent } = await t2.sm.open({
      runId: RUN,
      provider: KEV,
      capability: 'known-exploited-vulns',
      requestUrl: URL_A,
    });
    const other = {
      ...KEV,
      ensName: 'cve.chirag126.eth',
      payTo: '0.0.11183141',
      priceAtomic: '150000',
    };
    const p = await t2.sm.decide(intent.id, allow(intent, other));
    assert.equal(p.status, 'REFUSED');
    assert.equal(p.refusalCode, 'DECISION_MISMATCH');
    await assert.rejects(t2.sm.decide(intent.id, allow(intent)), /not CREATED/);
  });

  it('spend state comes from persisted intents, and the firewall uses it', async () => {
    const t = setup();
    await at(t, 'UNKNOWN'); // committed: may have moved
    const failed = await at(t, 'FAILED', `${KEV.endpoint}/recent?limit=1`); // not committed, but a started payment
    await at(t, 'REFUSED', `${KEV.endpoint}/recent?limit=2`); // neither
    const s = await t.sm.spendState(RUN, '2026-10-27T00:00:00.000Z', '2026-10-28T00:00:00.000Z');
    assert.equal(s.runCommitted, 100_000n, 'only the UNKNOWN one counts');
    assert.equal(s.dayCommitted, 100_000n);
    assert.equal(s.runPayments, 2, 'UNKNOWN and FAILED were started; REFUSED was not');
    assert.equal(failed.errorCode, 'NEVER_SENT');
    const d = authorize({
      intent: { provider: KEV.ensName, capability: 'known-exploited-vulns', rationale: 'again' },
      quote: {
        scheme: 'exact',
        network: 'hedera:testnet',
        asset: '0.0.0',
        amount: '100000',
        payTo: KEV.payTo,
        extra: { feePayer: FEE_PAYER },
      },
      requestUrl: URL_A,
      providers: [KEV],
      snapshot: { blockNumber: 1n, observedAt: t.nowIso() },
      state: s,
      policy: {
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
      },
      now: t.nowIso(),
    });
    assert.equal(
      d.allow ? 'ALLOW' : d.code,
      'DUPLICATE_PURCHASE',
      'the UNKNOWN purchase blocks buying it again',
    );
  });
});

describe('UNKNOWN reconciliation', () => {
  it('settles from a matching Mirror Node entry', async () => {
    const t = setup();
    const p = await at(t, 'UNKNOWN');
    const r = await t.sm.reconcile(p.id, [mirrorFor(p.transactionId ?? '')], PAYER);
    assert.equal(r.outcome, 'SETTLED');
    assert.equal(r.intent.status, 'SETTLED');
    assert.equal(r.intent.errorCode, null);
  });

  it('stays UNKNOWN (attempt counted) while the transaction could still appear', async () => {
    const t = setup();
    const p = await at(t, 'UNKNOWN');
    t.advance(60);
    const r = await t.sm.reconcile(p.id, [], PAYER);
    assert.equal(r.outcome, 'PENDING');
    assert.equal(r.intent.status, 'UNKNOWN');
    assert.equal(r.intent.reconcileAttempts, 1);
    assert.equal(r.intent.errorCode, 'NOT_YET_VISIBLE');
  });

  it('fails once the validity window has closed without a consensus entry', async () => {
    const t = setup();
    const p = await at(t, 'UNKNOWN');
    t.advance(301);
    const r = await t.sm.reconcile(p.id, [], PAYER);
    assert.equal(r.outcome, 'FAILED');
    assert.equal(r.intent.errorCode, 'TX_EXPIRED_NOT_FOUND');
  });

  it('fails with the consensus result when the transaction failed on chain', async () => {
    const t = setup();
    const p = await at(t, 'SUBMITTED');
    const r = await t.sm.reconcile(
      p.id,
      [mirrorFor(p.transactionId ?? '', { result: 'INSUFFICIENT_PAYER_BALANCE', transfers: [] })],
      PAYER,
    );
    assert.equal(r.intent.status, 'FAILED');
    assert.equal(r.intent.errorCode, 'TX_RESULT_INSUFFICIENT_PAYER_BALANCE');
  });

  it('a settlement that does not match is flagged and left UNKNOWN, never settled', async () => {
    const t = setup();
    const p = await at(t, 'UNKNOWN');
    const wrong = mirrorFor(p.transactionId ?? '', {
      transfers: [
        { account: PAYER, amount: -100_000n },
        { account: '0.0.666', amount: 100_000n },
      ],
    });
    t.advance(1000);
    const r = await t.sm.reconcile(p.id, [wrong], PAYER);
    assert.equal(r.outcome, 'MISMATCH');
    assert.equal(r.intent.status, 'UNKNOWN');
    assert.equal(r.intent.errorCode, 'SETTLEMENT_MISMATCH');
  });

  it('only SUBMITTED and UNKNOWN payments are reconciled', async () => {
    const t = setup();
    const p = await at(t, 'SETTLED');
    await assert.rejects(
      t.sm.reconcile(p.id, [], PAYER),
      (e: unknown) => e instanceof PaymentStateError && e.code === 'NOT_RECONCILABLE',
    );
  });
});

describe('SETTLED only after a Mirror Node verification (D-044)', () => {
  it('the database refuses SETTLED without a SETTLED verification for that transaction', async () => {
    const t = setup();
    const p = await at(t, 'UNKNOWN');
    const settle = (verification?: SettlementVerification) =>
      t.store.transition({
        id: p.id,
        from: 'UNKNOWN',
        to: 'SETTLED',
        patch: { settledAt: t.nowIso() },
        detail: {},
        at: t.nowIso(),
        ...(verification === undefined ? {} : { verification }),
      });
    await assert.rejects(settle(), /SETTLED only after a Mirror Node verification/);
    await assert.rejects(
      settle({ ...verified(p), outcome: 'MISMATCH', code: 'SETTLEMENT_MISMATCH' }),
      /SETTLED only after a Mirror Node verification/,
    );
    await assert.rejects(
      settle({ ...verified(p), transactionId: `${FEE_PAYER}@1.000000001` }),
      /SETTLED only after a Mirror Node verification/,
      'a verification of another transaction does not count',
    );
    assert.equal((await t.store.get(p.id))?.status, 'UNKNOWN');
    assert.equal((await settle(verified(p))).status, 'SETTLED');
  });

  it('verifications are append-only and every reconciliation records one', async () => {
    const t = setup();
    const p = await at(t, 'UNKNOWN');
    t.advance(30);
    await t.sm.reconcile(p.id, [], PAYER, {
      mirrorNode: 'https://mirror.test',
      mirrorNetwork: 'testnet',
    });
    await t.sm.reconcile(p.id, [mirrorFor(p.transactionId ?? '')], PAYER, {
      mirrorNode: 'https://mirror.test',
      mirrorNetwork: 'testnet',
    });
    const vs = await t.store.verifications(p.id);
    assert.deepEqual(
      vs.map((v) => v.outcome),
      ['PENDING', 'SETTLED'],
    );
    assert.equal(vs[1]?.mirrorNode, 'https://mirror.test');
    assert.ok(vs[1]?.checks.some((c) => c.startsWith('OK payee credited exactly')));
    assert.throws(
      () => t.db.prepare('UPDATE settlement_verifications SET outcome = ?').run('FAILED'),
      /append-only/,
    );
    assert.throws(() => t.db.prepare('DELETE FROM settlement_verifications').run(), /append-only/);
  });

  it('a payment on another network than the Mirror Node is never settled by it', async () => {
    const t = setup();
    const p = await at(t, 'UNKNOWN');
    const r = await t.sm.reconcile(p.id, [mirrorFor(p.transactionId ?? '')], PAYER, {
      mirrorNetwork: 'mainnet',
    });
    assert.equal(r.outcome, 'UNVERIFIABLE');
    assert.equal(r.intent.status, 'UNKNOWN');
    assert.equal(r.intent.errorCode, 'NETWORK_MISMATCH');
  });
});
