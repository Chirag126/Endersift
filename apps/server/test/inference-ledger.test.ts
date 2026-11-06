// Class: unit (SQLite in memory). Proves the daily cap by reservation, the
// settle/reconcile lifecycle and balance snapshots. Needs zod and the
// workspace links to @agent-economy/core and @agent-economy/zg.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import {
  LedgerError,
  SqliteInferenceLedger,
  type ReserveInput,
} from '../src/ledger/inference-ledger.ts';

const DAY = '2026-10-27';
const at = (hh: string) => `${DAY}T${hh}:00:00.000Z`;
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const PROVIDER = '0x1cB95Eb66Cc67C62d4DE0CC96726C5A5d82e7C85';

function ledger() {
  return new SqliteInferenceLedger(openDatabase(':memory:').db);
}

const reserveInput = (n: number, worst: bigint, cap: bigint, when = at('08')): ReserveInput => ({
  id: uuid(n),
  runId: null,
  purpose: 'ANALYZE',
  network: 'testnet',
  model: '0gm-1.0-35b-a3b',
  worstCaseNeuron: worst,
  dailyCapNeuron: cap,
  at: when,
});

const billing = (requestId: string, cost: bigint) => ({
  requestId,
  provider: PROVIDER,
  promptTokens: 502,
  completionTokens: 229,
  costNeuron: cost,
  teeVerified: true,
});

describe('daily cap by reservation', () => {
  it('reserves the worst case, then counts the billed cost once settled', async () => {
    const l = ledger();
    const r = await l.reserve(reserveInput(1, 1_926n, 5_000n));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.call.status, 'PENDING');
    assert.equal(r.spentBefore, 0n);
    assert.equal(r.remainingAfter, 3_074n);
    assert.equal((await l.spentOnDay(DAY)).spent, 1_926n, 'PENDING counts at the worst case');
    await l.settle(uuid(1), { status: 'SUCCEEDED', ...billing('req-1', 754n) }, at('09'));
    const spend = await l.spentOnDay(DAY);
    assert.equal(spend.spent, 754n, 'settled calls count at the billed cost');
    assert.equal(spend.byStatus.SUCCEEDED, 1);
  });

  it('refuses a call whose worst case would cross the cap, and records the refusal', async () => {
    const l = ledger();
    assert.ok((await l.reserve(reserveInput(1, 3_000n, 5_000n))).ok);
    const refused = await l.reserve(reserveInput(2, 2_001n, 5_000n));
    assert.equal(refused.ok, false);
    if (refused.ok) return;
    assert.equal(refused.code, 'DAILY_CAP_EXCEEDED');
    assert.equal(refused.call.status, 'REFUSED');
    assert.equal(refused.call.errorCode, 'DAILY_CAP_EXCEEDED');
    assert.equal((await l.spentOnDay(DAY)).spent, 3_000n, 'a refusal costs nothing');
    assert.ok(
      (await l.reserve(reserveInput(3, 2_000n, 5_000n))).ok,
      'exactly at the cap is allowed',
    );
  });

  it('keeps UNKNOWN outcomes at the worst case and Router errors at zero', async () => {
    const l = ledger();
    await l.reserve(reserveInput(1, 1_000n, 10_000n));
    await l.reserve(reserveInput(2, 1_000n, 10_000n));
    await l.reserve(reserveInput(3, 1_000n, 10_000n));
    await l.settle(uuid(1), { status: 'UNKNOWN', errorCode: 'TRANSPORT' }, at('09'));
    await l.settle(
      uuid(2),
      { status: 'FAILED', errorCode: 'ROUTER_402_insufficient_balance', requestId: null },
      at('09'),
    );
    await l.settle(
      uuid(3),
      { status: 'FAILED', errorCode: 'OUTPUT_SCHEMA_INVALID', ...billing('req-3', 400n) },
      at('09'),
    );
    const spend = await l.spentOnDay(DAY);
    assert.equal(spend.spent, 1_000n + 0n + 400n);
    assert.deepEqual({ u: spend.byStatus.UNKNOWN, f: spend.byStatus.FAILED }, { u: 1, f: 2 });
  });

  it('counts each UTC day separately', async () => {
    const l = ledger();
    await l.reserve(reserveInput(1, 4_000n, 5_000n, '2026-10-26T23:59:59.999Z'));
    assert.ok((await l.reserve(reserveInput(2, 4_000n, 5_000n, '2026-10-27T00:00:00.000Z'))).ok);
    assert.equal((await l.spentOnDay('2026-10-26')).spent, 4_000n);
    assert.equal((await l.spentOnDay('2026-10-27')).spent, 4_000n);
  });

  it('refuses nonsense inputs', async () => {
    const l = ledger();
    await assert.rejects(l.reserve(reserveInput(1, 0n, 5_000n)), LedgerError);
    await assert.rejects(l.reserve(reserveInput(1, 1n, 0n)), /invalid cap inputs/);
  });
});

describe('settle and reconcile', () => {
  it('allows only forward transitions', async () => {
    const l = ledger();
    await l.reserve(reserveInput(1, 1_000n, 5_000n));
    await l.settle(uuid(1), { status: 'SUCCEEDED', ...billing('req-1', 10n) }, at('09'));
    await assert.rejects(
      l.settle(uuid(1), { status: 'UNKNOWN', errorCode: 'X' }, at('10')),
      /illegal inference transition SUCCEEDED → UNKNOWN/,
    );
    await assert.rejects(
      l.settle(uuid(9), { status: 'UNKNOWN', errorCode: 'X' }, at('10')),
      /does not exist/,
    );
  });

  it('lets an UNKNOWN call be resolved once its billing is known', async () => {
    const l = ledger();
    await l.reserve(reserveInput(1, 1_000n, 5_000n));
    await l.settle(uuid(1), { status: 'UNKNOWN', errorCode: 'TIMEOUT' }, at('09'));
    const done = await l.settle(
      uuid(1),
      { status: 'SUCCEEDED', ...billing('req-1', 10n) },
      at('10'),
    );
    assert.equal(done.errorCode, null);
    assert.equal((await l.spentOnDay(DAY)).spent, 10n);
  });

  it('stores the funding split from usage history, including deposit-funded calls', async () => {
    const l = ledger();
    await l.reserve(reserveInput(1, 1_926n, 5_000n));
    await l.settle(uuid(1), { status: 'SUCCEEDED', ...billing('req-1', 754n) }, at('09'));
    const call = await l.reconcile(
      uuid(1),
      { creditUsedNeuron: 0n, depositUsedNeuron: 315n, funding: 'deposit' },
      at('10'),
    );
    assert.equal(call.funding, 'deposit');
    assert.equal(call.depositUsedNeuron, '315');
    assert.equal(call.reconciledAt, at('10'));
    assert.equal((await l.getCall(uuid(1)))?.reconciledAt, at('10'));
    await assert.rejects(
      l.reconcile(
        uuid(1),
        { creditUsedNeuron: 0n, depositUsedNeuron: 0n, funding: 'credits' },
        at('11'),
      ),
      /credit funding requires credit_used > 0/,
    );
  });

  it('refuses to reconcile a call that was never billed', async () => {
    const l = ledger();
    await l.recordRefusal({
      id: uuid(1),
      runId: null,
      purpose: 'ANALYZE',
      network: 'testnet',
      model: 'm',
      errorCode: 'COST_OVER_CAP',
      worstCaseNeuron: 9n,
      at: at('08'),
    });
    await assert.rejects(
      l.reconcile(
        uuid(1),
        { creditUsedNeuron: 0n, depositUsedNeuron: 0n, funding: 'none' },
        at('09'),
      ),
      /no billed cost/,
    );
    const [row] = await l.listCalls({ from: at('00'), to: at('23') });
    assert.equal(row?.status, 'REFUSED');
    assert.equal(row?.errorCode, 'COST_OVER_CAP');
  });
});

describe('balance snapshots', () => {
  it('store every Router figure and list newest first', async () => {
    const l = ledger();
    const base = {
      network: 'testnet' as const,
      address: '0x125f33a973257b472194676e760aa1afcbeb8ce5',
      depositBalanceNeuron: '0',
      creditBalanceNeuron: '0',
      pendingChargeNeuron: '439151333333333',
      totalBalanceNeuron: '0',
      balanceNeuron: null,
      trigger: 'job' as const,
    };
    await l.recordBalanceSnapshot({ ...base, id: uuid(1), takenAt: at('08') });
    await l.recordBalanceSnapshot({ ...base, id: uuid(2), takenAt: at('09'), trigger: 'manual' });
    const [latest, older] = await l.listBalanceSnapshots(10);
    assert.equal(latest?.id, uuid(2));
    assert.equal(older?.pendingChargeNeuron, '439151333333333');
    assert.equal(older?.balanceNeuron, null);
  });
});
