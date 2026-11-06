// Class: unit. The owner's persisted spending policy (D-052): validation
// against the env ceiling, append-only versions with compare-and-set, and the
// effective policy the firewall receives.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { tighter } from '../src/orchestrator/orchestrator.ts';
import {
  PolicyConflictError,
  PolicyStore,
  PolicyValidationError,
  parsePolicyUpdate,
  policyView,
} from '../src/policy/policy-store.ts';
import { spendingPolicyFromEnv } from '@agent-economy/policy';
import { POLICY } from './support/orchestrator-harness.ts';

const body = (over: Record<string, unknown> = {}) => ({
  maxPerPayment: '200000',
  maxPerRun: '500000',
  maxPerDay: '2000000',
  maxPaymentsPerRun: 3,
  paymentsPaused: false,
  expectedVersion: null,
  ...over,
});

const store = () => new PolicyStore(openDatabase(':memory:').db, POLICY);

describe('policy update validation', () => {
  it('accepts limits at or under the ceiling, in order', () => {
    const r = parsePolicyUpdate(body({ reason: '  demo  ' }), POLICY);
    assert.ok(r.ok);
    assert.equal(r.update.limits.maxPerRun, 500_000n);
    assert.equal(r.update.reason, 'demo');
    assert.ok(
      parsePolicyUpdate(
        body({
          maxPerPayment: POLICY.maxPerPayment.toString(),
          maxPerRun: POLICY.maxPerRun.toString(),
          maxPerDay: POLICY.maxPerDay.toString(),
          maxPaymentsPerRun: POLICY.maxPaymentsPerRun,
        }),
        POLICY,
      ).ok,
      'the ceiling itself is allowed',
    );
  });

  it('reports every problem: above the ceiling, out of order, wrong types, unknown fields', () => {
    const r = parsePolicyUpdate(
      {
        maxPerPayment: '1.5',
        maxPerRun: (POLICY.maxPerRun + 1n).toString(),
        maxPerDay: '100',
        maxPaymentsPerRun: POLICY.maxPaymentsPerRun + 1,
        paymentsPaused: 1,
        expectedVersion: 'latest',
        reason: 'x'.repeat(201),
        payTo: '0.0.666',
      },
      POLICY,
    );
    assert.ok(!r.ok);
    for (const re of [
      /unknown field\(s\): payTo/,
      /maxPerPayment must be a positive integer string/,
      /maxPerRun \d+ is above the server ceiling/,
      /maxPerRun must not be above maxPerDay/,
      /maxPaymentsPerRun \d+ is above the server ceiling/,
      /paymentsPaused must be true or false/,
      /expectedVersion/,
      /reason is at most 200/,
    ])
      assert.ok(
        r.problems.some((p) => re.test(p)),
        `${String(re)} in ${r.problems.join(' | ')}`,
      );
  });
});

describe('policy store', () => {
  it('is the env ceiling until the owner saves a version', () => {
    const s = store();
    const e = s.effective();
    assert.equal(e.source, 'env');
    assert.equal(e.version, null);
    assert.equal(e.policy.maxPerRun, POLICY.maxPerRun);
    assert.equal(e.policy.paymentsPaused, false);
  });

  it('saves versions in order with compare-and-set; the latest is in force', () => {
    const s = store();
    const first = parsePolicyUpdate(body({ paymentsPaused: true }), POLICY);
    assert.ok(first.ok);
    assert.equal(s.save(first.update).version, 1);
    assert.equal(s.effective().policy.paymentsPaused, true);
    assert.equal(s.effective().policy.maxPerRun, 500_000n);
    // a stale writer (still on "no version") is refused, nothing is written
    assert.throws(() => s.save(first.update), PolicyConflictError);
    const second = parsePolicyUpdate(body({ expectedVersion: 1 }), POLICY);
    assert.ok(second.ok);
    assert.equal(s.save(second.update).version, 2);
    assert.deepEqual(
      s.history().map((v) => [v.version, v.paymentsPaused]),
      [
        [2, false],
        [1, true],
      ],
    );
  });

  it('re-validates on save (the UI is not the boundary)', () => {
    const s = store();
    assert.throws(
      () =>
        s.save({
          limits: {
            maxPerPayment: POLICY.maxPerPayment * 10n,
            maxPerRun: POLICY.maxPerRun * 10n,
            maxPerDay: POLICY.maxPerDay * 10n,
            maxPaymentsPerRun: 1,
            paymentsPaused: false,
            approvalMode: 'autonomous',
            approvalAboveTinybars: 0n,
            providerDailyCaps: {},
          },
          expectedVersion: null,
          reason: null,
        }),
      PolicyValidationError,
    );
    assert.equal(s.latest(), null);
  });

  it('versions are append-only in the database', () => {
    const { db } = openDatabase(':memory:');
    const s = new PolicyStore(db, POLICY);
    const u = parsePolicyUpdate(body(), POLICY);
    assert.ok(u.ok);
    s.save(u.update);
    assert.throws(
      () => db.prepare('UPDATE policy_versions SET payments_paused = 1').run(),
      /append-only/,
    );
    assert.throws(() => db.prepare('DELETE FROM policy_versions').run(), /append-only/);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO policy_versions (version, max_per_payment, max_per_run, max_per_day, max_payments_per_run, payments_paused, changed_by, created_at)
             VALUES (5, '1', '1', '1', 1, 0, 'owner', 'now')`,
          )
          .run(),
      /without gaps/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO policy_versions (version, max_per_payment, max_per_run, max_per_day, max_payments_per_run, payments_paused, changed_by, created_at)
             VALUES (2, '-1', '1', '1', 1, 0, 'owner', 'now')`,
          )
          .run(),
      /CHECK/,
    );
  });

  it('a version saved under a higher env ceiling is clamped to the current one', () => {
    const { db } = openDatabase(':memory:');
    const high = new PolicyStore(db, POLICY);
    const u = parsePolicyUpdate(
      body({
        maxPerPayment: POLICY.maxPerPayment.toString(),
        maxPerRun: POLICY.maxPerRun.toString(),
        maxPerDay: POLICY.maxPerDay.toString(),
      }),
      POLICY,
    );
    assert.ok(u.ok);
    high.save(u.update);
    // the operator later lowers the env limits below the saved version
    const lowered = { ...POLICY, maxPerPayment: 400_000n, maxPerRun: 500_000n };
    const low = new PolicyStore(db, lowered);
    const e = low.effective();
    assert.equal(e.policy.maxPerRun, 500_000n);
    assert.equal(e.policy.maxPerPayment, 400_000n);
    assert.equal(e.policy.maxPerDay, POLICY.maxPerDay);
    assert.deepEqual(e.clamped, ['maxPerRun', 'maxPerPayment']);
    const view = policyView(low);
    assert.deepEqual(view['clamped'], ['maxPerRun', 'maxPerPayment']);
  });

  it('the server kill switch (X402_PAYMENTS_PAUSED) cannot be lifted by a saved version (D-062)', () => {
    const s = new PolicyStore(openDatabase(':memory:').db, { ...POLICY, paymentsPaused: true });
    assert.equal(s.effective().policy.paymentsPaused, true, 'paused before any version');
    const update = parsePolicyUpdate(body({ paymentsPaused: false }), POLICY);
    assert.ok(update.ok);
    s.save(update.update);
    assert.equal(s.effective().source, 'owner');
    assert.equal(s.effective().policy.paymentsPaused, true, 'still paused after "not paused"');
    assert.equal(policyView(s)['serverPaused'], true);
    assert.equal(policyView(store())['serverPaused'], false);
  });

  it('spendingPolicyFromEnv reads X402_PAYMENTS_PAUSED', () => {
    const values: Record<string, string> = {
      X402_NETWORK: 'hedera:testnet',
      X402_ASSET: '0.0.0',
      X402_MAX_PAYMENT_TINYBARS: '1000000',
      X402_RUN_BUDGET_TINYBARS: '3000000',
      X402_DAILY_BUDGET_TINYBARS: '10000000',
      X402_MAX_PAYMENTS_PER_RUN: '10',
      X402_SNAPSHOT_MAX_AGE_SEC: '600',
    };
    const env = (extra: Record<string, string>) => ({
      require: (n: string) => {
        const v = { ...values, ...extra }[n];
        if (v === undefined) throw new Error(n);
        return v;
      },
      get: (n: string) => ({ ...values, ...extra })[n],
    });
    assert.equal(spendingPolicyFromEnv(env({}), '0.0.1').paymentsPaused, undefined);
    assert.equal(
      spendingPolicyFromEnv(env({ X402_PAYMENTS_PAUSED: 'false' }), '0.0.1').paymentsPaused,
      undefined,
    );
    assert.equal(
      spendingPolicyFromEnv(env({ X402_PAYMENTS_PAUSED: 'true' }), '0.0.1').paymentsPaused,
      true,
    );
  });

  it('tighter() takes the lower limit field by field, and a pause in either wins', () => {
    const t = tighter(
      { ...POLICY, maxPerRun: 100n, maxPerPayment: 100n },
      { ...POLICY, maxPerDay: 1000n, paymentsPaused: true },
    );
    assert.equal(t.maxPerRun, 100n);
    assert.equal(t.maxPerDay, 1000n);
    assert.equal(t.paymentsPaused, true);
  });
});
