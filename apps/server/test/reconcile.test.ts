// Class: unit. Ledger ↔ usage-history reconciliation and the balance snapshot
// job, with the live 2026-10-27 testnet figures.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InferenceCall } from '@agent-economy/core/domain';
import { parseUsageEntry, type UsageEntry } from '@agent-economy/zg';
import { openDatabase } from '../src/db/database.ts';
import { startBalanceSnapshotJob, takeBalanceSnapshot } from '../src/ledger/balance-job.ts';
import { SqliteInferenceLedger } from '../src/ledger/inference-ledger.ts';
import { fundingOf, pendingPortion, reconcileWithUsage } from '../src/ledger/reconcile.ts';

const PROVIDER = '0x1cB95Eb66Cc67C62d4DE0CC96726C5A5d82e7C85';
const REQ = '3081e4b7-e4e1-43f9-9a0d-b670b6eb4d03';

const entry = (over: Record<string, unknown> = {}): UsageEntry => {
  const e = parseUsageEntry({
    request_id: REQ,
    provider_address: PROVIDER,
    model_id: '0GM-1.0-35B-A3B',
    canonical_id: '0gm-1.0-35b-a3b',
    input_tokens: 502,
    output_tokens: 229,
    cost: '753694000000000',
    credit_used: '0',
    deposit_used: '314542666666667',
    created_at: '2026-10-27T08:36:40.291Z',
    ...over,
  });
  assert.ok(e !== null);
  return e;
};

const call = (over: Partial<InferenceCall> = {}): InferenceCall => ({
  id: '00000000-0000-4000-8000-000000000001',
  runId: null,
  purpose: 'ANALYZE',
  network: 'testnet',
  model: '0gm-1.0-35b-a3b',
  status: 'SUCCEEDED',
  requestId: REQ,
  provider: PROVIDER.toLowerCase(),
  promptTokens: 502,
  completionTokens: 229,
  worstCaseNeuron: '1926244000000000',
  costNeuron: '753694000000000',
  creditUsedNeuron: null,
  depositUsedNeuron: null,
  funding: 'unknown',
  teeVerified: true,
  errorCode: null,
  createdAt: '2026-10-27T08:36:36.801Z',
  settledAt: '2026-10-27T08:36:46.104Z',
  reconciledAt: null,
  ...over,
});

describe('reconcileWithUsage', () => {
  it('matches the live call field for field (provider case-insensitive)', () => {
    const r = reconcileWithUsage([call()], [entry()]);
    assert.equal(r.verdict, 'MATCH');
    assert.equal(r.rows[0]?.outcome, 'MATCH');
    assert.deepEqual(r.unledgered, []);
  });

  it('lists every differing field', () => {
    const r = reconcileWithUsage([call({ costNeuron: '1', completionTokens: 9 })], [entry()]);
    assert.equal(r.verdict, 'MISMATCH');
    assert.deepEqual(
      r.rows[0]?.diffs.map((d) => d.field),
      ['cost_neuron', 'completion_tokens'],
    );
  });

  it('separates missing, out-of-window, unresolved and unledgered', () => {
    const other = entry({ request_id: 'other', created_at: '2026-10-27T09:00:00.000Z' });
    const r = reconcileWithUsage(
      [
        call({ requestId: 'old', createdAt: '2026-10-26T00:00:00.000Z' }),
        call({
          id: '00000000-0000-4000-8000-000000000002',
          requestId: 'gone',
          createdAt: '2026-10-27T09:30:00.000Z',
        }),
        call({
          id: '00000000-0000-4000-8000-000000000003',
          status: 'UNKNOWN',
          requestId: null,
          costNeuron: null,
        }),
        call({
          id: '00000000-0000-4000-8000-000000000004',
          status: 'REFUSED',
          requestId: null,
          costNeuron: null,
        }),
      ],
      [entry(), other],
    );
    assert.deepEqual(
      r.rows.map((x) => x.outcome),
      ['OUT_OF_WINDOW', 'MISSING_IN_ROUTER', 'UNRESOLVED', 'NOT_BILLED'],
    );
    assert.deepEqual(
      r.unledgered.map((e) => e.requestId).sort(),
      [REQ, 'other'],
      'entries no row claims, inside the ledger span',
    );
    assert.equal(r.verdict, 'MISMATCH');
  });

  it('flags a call recorded as unbilled that the Router did bill', () => {
    const r = reconcileWithUsage(
      [call({ status: 'FAILED', costNeuron: null, errorCode: 'ROUTER_500_x' })],
      [entry()],
    );
    assert.equal(r.rows[0]?.outcome, 'BILLED_UNRECORDED');
    assert.equal(r.verdict, 'MISMATCH');
  });

  it('says so when there is nothing to match', () => {
    assert.equal(reconcileWithUsage([], [entry()]).verdict, 'NOTHING_TO_MATCH');
  });

  it('derives funding and the portion still pending from the Payment Layer', () => {
    assert.deepEqual(fundingOf(entry()), {
      creditUsedNeuron: 0n,
      depositUsedNeuron: 314_542_666_666_667n,
      funding: 'deposit',
    });
    assert.equal(pendingPortion(entry()), 439_151_333_333_333n);
    assert.equal(fundingOf(entry({ credit_used: '5', deposit_used: '0' })).funding, 'credits');
  });
});

describe('balance snapshot job', () => {
  const body = {
    address: '0x125f33a973257b472194676e760aa1afcbeb8ce5',
    deposit_balance: '0',
    credit_balance: '0',
    pending_charge: '439151333333333',
    total_balance: '0',
    balance: '0',
  };

  it('stores one snapshot per read', async () => {
    const ledger = new SqliteInferenceLedger(openDatabase(':memory:').db);
    const s = await takeBalanceSnapshot(
      { client: { getBalanceRaw: async () => body }, ledger, network: 'testnet' },
      'manual',
    );
    assert.equal(s.pendingChargeNeuron, '439151333333333');
    assert.equal((await ledger.listBalanceSnapshots(5)).length, 1);
  });

  it('waits for the in-flight snapshot when stopped, and validates the interval', async () => {
    const ledger = new SqliteInferenceLedger(openDatabase(':memory:').db);
    let reads = 0;
    let release: () => void = () => {};
    const errors: unknown[] = [];
    const job = startBalanceSnapshotJob({
      client: {
        getBalanceRaw: async () => {
          reads += 1;
          if (reads === 1) await new Promise<void>((r) => (release = r));
          return body;
        },
      },
      ledger,
      network: 'testnet',
      intervalMs: 1000,
      onError: (e) => errors.push(e),
    });
    assert.equal(reads, 1, 'immediate first snapshot');
    release();
    await job.stop();
    assert.equal((await ledger.listBalanceSnapshots(5)).length, 1);
    assert.deepEqual(errors, []);
    assert.throws(
      () =>
        startBalanceSnapshotJob({
          client: { getBalanceRaw: async () => body },
          ledger,
          network: 'testnet',
          intervalMs: 10,
        }),
      /intervalMs/,
    );
  });

  it('reports a failed read through onError instead of throwing', async () => {
    const ledger = new SqliteInferenceLedger(openDatabase(':memory:').db);
    const errors: unknown[] = [];
    let done: () => void = () => {};
    const reported = new Promise<void>((r) => (done = r));
    const job = startBalanceSnapshotJob({
      client: {
        getBalanceRaw: async () => {
          throw new Error('router down');
        },
      },
      ledger,
      network: 'testnet',
      intervalMs: 60_000,
      onError: (e) => {
        errors.push(e);
        done();
      },
    });
    await reported;
    await job.stop();
    assert.match(String(errors[0]), /router down/);
    assert.equal((await ledger.listBalanceSnapshots(5)).length, 0);
  });
});
