// Class: unit and mock. Today's x402 spend from outside this database, read
// from the Mirror Node (D-062): what counts, what is skipped, and how the
// firewall and the orchestrator use it. The Mirror Node is faked.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MirrorTransaction } from '@agent-economy/hedera';
import { listRunEvents } from '../src/db/repositories.ts';
import { ChainSpendFloor, x402SpendOf } from '../src/payments/chain-floor.ts';
import {
  BUY_KEV,
  KEV,
  POLICY,
  analysisJson,
  harness,
  planJson,
} from './support/orchestrator-harness.ts';

const PAYER = '0.0.11044318';
const FACILITATOR = '0.0.7162784';

const tx = (id: string, transfers: [string, bigint][], result = 'SUCCESS'): MirrorTransaction => ({
  transactionId: id,
  result,
  name: 'CRYPTOTRANSFER',
  consensusTimestamp: `${id.split('-')[1]}.000000001`,
  chargedTxFee: 260_571n,
  transfers: transfers.map(([account, amount]) => ({ account, amount })),
});
/** An x402 payment: the facilitator pays the fee and moves `amount` from the payer. */
const x402 = (seconds: number, amount: bigint) =>
  tx(`${FACILITATOR}-${seconds}-000000001`, [
    [PAYER, -amount],
    [KEV.payTo, amount],
    [FACILITATOR, -260_571n],
    ['0.0.802', 260_571n],
  ]);

describe('x402SpendOf (D-062)', () => {
  it('counts payer debits in transfers whose fee another account paid', () => {
    const s = x402SpendOf([x402(1, 100_000n), x402(2, 150_000n)], PAYER, new Set());
    assert.deepEqual(s, {
      tinybars: 250_000n,
      count: 2,
      byPayee: { [KEV.payTo]: 250_000n },
    });
  });

  it("skips the payer's own transactions, failures, known IDs and repeated entries", () => {
    const own = tx(`${PAYER}-3-000000001`, [
      [PAYER, -5_000_000n],
      ['0.0.123', 5_000_000n],
    ]);
    const failed = tx(
      `${FACILITATOR}-4-000000001`,
      [[PAYER, -100_000n]],
      'INSUFFICIENT_PAYER_BALANCE',
    );
    const known = x402(5, 120_000n);
    const counted = x402(6, 100_000n);
    const s = x402SpendOf(
      [own, failed, known, counted, counted],
      PAYER,
      new Set([known.transactionId]),
    );
    assert.deepEqual(s, { tinybars: 100_000n, count: 1, byPayee: { [KEV.payTo]: 100_000n } });
  });

  it('ignores a transfer that credits the payer', () => {
    const refund = tx(`${FACILITATOR}-7-000000001`, [
      [KEV.payTo, -100_000n],
      [PAYER, 100_000n],
    ]);
    assert.deepEqual(x402SpendOf([refund], PAYER, new Set()), {
      tinybars: 0n,
      count: 0,
      byPayee: {},
    });
  });
});

describe('x402SpendOf per payee (D-066)', () => {
  it('attributes each payment to the one account credited exactly the debit', () => {
    const cve = '0.0.11183141';
    const toCve = tx(`${FACILITATOR}-8-000000001`, [
      [PAYER, -150_000n],
      [cve, 150_000n],
      [FACILITATOR, -260_571n],
      ['0.0.802', 260_571n],
    ]);
    // two accounts credited the same amount: the payee is ambiguous, so it is not attributed
    const split = tx(`${FACILITATOR}-9-000000001`, [
      [PAYER, -100_000n],
      ['0.0.1', 50_000n],
      ['0.0.2', 50_000n],
    ]);
    const s = x402SpendOf([x402(1, 100_000n), toCve, split], PAYER, new Set());
    assert.equal(s.tinybars, 350_000n);
    assert.deepEqual(s.byPayee, { [KEV.payTo]: 100_000n, [cve]: 150_000n });
  });
});

describe('ChainSpendFloor (D-062)', () => {
  const now = () => new Date('2026-10-28T10:00:00.000Z');

  it('reads the whole UTC day from the Mirror Node, minus payments this database recorded', async () => {
    const asked: [string, number, number][] = [];
    const recorded = x402(1_793_145_600 + 60, 100_000n); // in the database already
    const floor = new ChainSpendFloor({
      payer: PAYER,
      now,
      mirror: {
        listAccountTransfers: async (account, from, to) => {
          asked.push([account, from, to]);
          return [recorded, x402(1_793_145_600 + 120, 150_000n)];
        },
      },
      knownTransactionIds: () => [`${FACILITATOR}@${1_793_145_600 + 60}.000000001`],
    });
    assert.equal(floor.floorFor('2026-10-28T00:00:00.000Z'), 0n, 'nothing before the first read');
    const r = await floor.refresh();
    assert.deepEqual(asked, [[PAYER, 1_793_145_600, 1_793_145_600 + 86_400]]);
    assert.equal(r.day, '2026-10-28');
    assert.equal(r.tinybars, 150_000n);
    assert.equal(r.count, 1);
    assert.equal(floor.floorFor('2026-10-28T00:00:00.000Z'), 150_000n);
    assert.equal(floor.floorFor('2026-10-29T00:00:00.000Z'), 0n, 'only for the day it read');
  });

  it('throws when the Mirror Node cannot be read, keeping no stale reading for a new day', async () => {
    const floor = new ChainSpendFloor({
      payer: PAYER,
      now,
      mirror: {
        listAccountTransfers: async () => {
          throw new Error('Mirror Node HTTP 503');
        },
      },
      knownTransactionIds: () => [],
    });
    await assert.rejects(floor.refresh(), /503/);
    assert.equal(floor.last, null);
  });
});

describe('the firewall and the orchestrator use it (mock, D-062)', () => {
  const WATCHLIST = ['OpenSSL'];

  it("outside spend counts against today's budget: a purchase that would exceed it is refused", async () => {
    const h = harness({
      policy: { ...POLICY, maxPerPayment: 150_000n, maxPerRun: 150_000n, maxPerDay: 150_000n },
      dayFloor: 100_000n, // paid before a restart, found on the Mirror Node
      plan: () => planJson([BUY_KEV]),
      analysis: () => analysisJson(['CVE-2026-1001']),
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    const refused = listRunEvents(h.db, run.id).filter((e) => e.type === 'PAYMENT_REFUSED');
    assert.deepEqual(
      refused.map((e) => e.payload['code']),
      ['OVER_DAILY_BUDGET'],
    );
    assert.equal(h.log.filter((l) => l.startsWith('sign ')).length, 0);
  });

  it('an unreadable Mirror Node fails the run before any 0G call or payment', async () => {
    const h = harness({
      spendCheck: async () => {
        throw new Error('Mirror Node HTTP 503');
      },
      plan: () => planJson([BUY_KEV]),
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'FAILED');
    assert.match(run.error ?? '', /^SPEND_UNVERIFIED: .*503/);
    assert.equal(h.prompts.length, 0);
    assert.equal((await h.store.listByRun(run.id)).length, 0);
    assert.deepEqual(
      listRunEvents(h.db, run.id).map((e) => e.type),
      ['RUN_STARTED', 'RUN_FAILED'],
    );
  });

  it('a readable Mirror Node lets the run go on', async () => {
    let checks = 0;
    const h = harness({
      spendCheck: async () => {
        checks += 1;
      },
      plan: () => planJson([BUY_KEV]),
      analysis: () => analysisJson(['CVE-2026-1001']),
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'SUCCEEDED', run.error ?? '');
    assert.equal(checks, 1);
  });
});
