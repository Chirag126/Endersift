// Class: unit and mock. NOT live verification. The spending controls of
// D-066: Human approval mode (the default stays autonomous), per-provider
// daily caps, and the self-purchase guard, through the real store, firewall,
// buyer, orchestrator and API with the MOCK harness (fake ENS, providers,
// signer, Mirror Node, 0G).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { createApi } from '../src/api/server.ts';
import { severityOf, stageOf, summarizeRun } from '../src/api/run-summary.ts';
import { TaskRunner } from '../src/api/task-runner.ts';
import { openDatabase } from '../src/db/database.ts';
import { createRun, listRunEvents } from '../src/db/repositories.ts';
import { ApprovalError, ApprovalStore } from '../src/payments/approvals.ts';
import { EarningsReader, salesOf } from '../src/payments/earnings.ts';
import { tighter } from '../src/orchestrator/orchestrator.ts';
import {
  PolicyStore,
  needsApproval,
  parsePolicyUpdate,
  policyView,
} from '../src/policy/policy-store.ts';
import {
  BUY_KEV,
  BUY_OSV,
  KEV,
  NOW,
  OSV,
  PAYER,
  POLICY,
  PUBLIC_CONFIG,
  analysisJson,
  harness,
  planJson,
  type HarnessOptions,
} from './support/orchestrator-harness.ts';

const WATCHLIST = ['OpenSSL', 'lodash@4.17.21 (npm)'];
const CODE = 'test-access-code-123';
const LIMITS = {
  maxPerPayment: POLICY.maxPerPayment,
  maxPerRun: POLICY.maxPerRun,
  maxPerDay: POLICY.maxPerDay,
  maxPaymentsPerRun: POLICY.maxPaymentsPerRun,
  paymentsPaused: false,
};

const types = (db: DatabaseSync, runId: string) => listRunEvents(db, runId).map((e) => e.type);
const eventsOf = (db: DatabaseSync, runId: string, type: string) =>
  listRunEvents(db, runId).filter((e) => e.type === type);

function humanHarness(
  over: Partial<HarnessOptions> = {},
  rule: { above?: bigint; caps?: Record<string, bigint> } = {},
) {
  const h = harness({
    plan: () => planJson([BUY_KEV, BUY_OSV]),
    analysis: () => analysisJson(['CVE-2026-1001']),
    ...over,
  });
  h.policyStore.save({
    limits: {
      ...LIMITS,
      approvalMode: 'human',
      approvalAboveTinybars: rule.above ?? 0n,
      providerDailyCaps: rule.caps ?? {},
    },
    expectedVersion: null,
    reason: 'human approval',
  });
  return h;
}

// ── the owner policy: approval mode and per-provider caps ────────────────

describe('owner policy: approval mode and per-provider caps (D-066)', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    maxPerPayment: '200000',
    maxPerRun: '500000',
    maxPerDay: '2000000',
    maxPaymentsPerRun: 3,
    paymentsPaused: false,
    expectedVersion: null,
    ...over,
  });

  it('defaults to autonomous with no caps; old clients that leave the fields out keep the saved ones', () => {
    const s = new PolicyStore(openDatabase(':memory:').db, POLICY);
    assert.deepEqual(s.effective().approval, { mode: 'autonomous', aboveTinybars: 0n });
    const first = parsePolicyUpdate(
      body({
        approvalMode: 'human',
        approvalAboveTinybars: '150000',
        providerDailyCaps: { [KEV.ensName]: '300000' },
      }),
      POLICY,
    );
    assert.ok(first.ok);
    s.save(first.update);
    assert.deepEqual(s.effective().approval, { mode: 'human', aboveTinybars: 150_000n });
    assert.deepEqual(s.effective().policy.providerDailyCaps, { [KEV.ensName]: 300_000n });
    // a client that knows nothing of D-066 saves a new version: the fields are carried over
    const second = parsePolicyUpdate(body({ expectedVersion: 1 }), POLICY, s.latest());
    assert.ok(second.ok);
    s.save(second.update);
    assert.equal(s.latest()?.version, 2);
    assert.equal(s.effective().approval.mode, 'human');
    assert.deepEqual(s.effective().policy.providerDailyCaps, { [KEV.ensName]: 300_000n });
    // and the store itself carries them over when an update object leaves them out
    s.save({ limits: { ...LIMITS }, expectedVersion: 2, reason: null });
    assert.equal(s.effective().approval.aboveTinybars, 150_000n);
  });

  it('reports every bad approval or cap field', () => {
    const r = parsePolicyUpdate(
      body({
        approvalMode: 'sometimes',
        approvalAboveTinybars: '-1',
        providerDailyCaps: {
          'NOT A NAME': '5',
          [KEV.ensName]: '0',
          [OSV.ensName]: '9000000',
        },
      }),
      POLICY,
    );
    assert.ok(!r.ok);
    for (const re of [
      /approvalMode must be/,
      /approvalAboveTinybars must be a whole number/,
      /is not an ENS name/,
      /providerDailyCaps\[kev\.chirag126\.eth\] must be a positive integer/,
      /providerDailyCaps\[osv\.chirag126\.eth\] must not be above maxPerDay/,
    ])
      assert.ok(
        r.problems.some((p) => re.test(p)),
        `${String(re)} in ${r.problems.join(' | ')}`,
      );
    const many = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`p${i}.chirag126.eth`, '1']),
    );
    const tooMany = parsePolicyUpdate(body({ providerDailyCaps: many }), POLICY);
    assert.ok(!tooMany.ok && tooMany.problems.some((p) => /at most 20/.test(p)));
  });

  it('a cap above a lowered daily limit is clamped, and the view shows strings', () => {
    const { db } = openDatabase(':memory:');
    const s = new PolicyStore(db, POLICY);
    s.save({
      limits: { ...LIMITS, providerDailyCaps: { [KEV.ensName]: POLICY.maxPerDay } },
      expectedVersion: null,
      reason: null,
    });
    const low = new PolicyStore(db, { ...POLICY, maxPerDay: 4_000_000n });
    assert.deepEqual(low.effective().policy.providerDailyCaps, { [KEV.ensName]: 4_000_000n });
    assert.ok(low.effective().clamped.includes('providerDailyCaps'));
    const view = policyView(low);
    const effective = view['effective'] as Record<string, unknown>;
    assert.deepEqual(effective['providerDailyCaps'], { [KEV.ensName]: '4000000' });
    assert.equal(effective['approvalMode'], 'autonomous');
  });

  it('needsApproval: autonomous never, human strictly above the threshold', () => {
    assert.equal(needsApproval({ mode: 'autonomous', aboveTinybars: 0n }, 10n ** 9n), false);
    assert.equal(needsApproval({ mode: 'human', aboveTinybars: 0n }, 1n), true);
    assert.equal(needsApproval({ mode: 'human', aboveTinybars: 100_000n }, 100_000n), false);
    assert.equal(needsApproval({ mode: 'human', aboveTinybars: 100_000n }, 100_001n), true);
  });

  it('tighter() keeps every per-provider cap, the lower where both set one', () => {
    const t = tighter(
      { ...POLICY, providerDailyCaps: { [KEV.ensName]: 500n, [OSV.ensName]: 900n } },
      { ...POLICY, providerDailyCaps: { [KEV.ensName]: 700n, 'cve.chirag126.eth': 100n } },
    );
    assert.deepEqual(t.providerDailyCaps, {
      [KEV.ensName]: 500n,
      [OSV.ensName]: 900n,
      'cve.chirag126.eth': 100n,
    });
    assert.equal(tighter(POLICY, POLICY).providerDailyCaps, undefined);
  });
});

// ── the approvals table ───────────────────────────────────────────────────

describe('payment approvals in the database (D-066)', () => {
  const setup = () => {
    const { db } = openDatabase(':memory:');
    let t = NOW.getTime();
    const store = new ApprovalStore(db, { now: () => new Date(t), timeoutSec: 60 });
    const runId = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
    createRun(db, {
      id: runId,
      trigger: 'manual',
      watchlist: ['OpenSSL'],
      status: 'QUEUED',
      createdAt: NOW.toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
    });
    // a payment intent row to reference (CREATED; raw insert of the minimal columns)
    const paymentId = '6a1d1f8e-3a52-4c0a-9b1e-2f6c1e0a9d11';
    db.prepare(
      `INSERT INTO payment_intents (id, run_id, provider, pay_to, network, asset, amount_atomic, status, created_at, updated_at, idempotency_key, capability, request_url, reconcile_attempts)
       VALUES (?, ?, ?, ?, 'hedera:testnet', '0.0.0', '100000', 'CREATED', ?, ?, ?, 'known-exploited-vulns', 'https://p.example/v1/kev/recent', 0)`,
    ).run(
      paymentId,
      runId,
      KEV.ensName,
      KEV.payTo,
      NOW.toISOString(),
      NOW.toISOString(),
      'a'.repeat(64),
    );
    const ask = () =>
      store.request({
        runId,
        paymentId,
        provider: KEV.ensName,
        capability: 'known-exploited-vulns',
        payTo: KEV.payTo,
        amountAtomic: '100000',
        requestUrl: 'https://p.example/v1/kev/recent',
        threshold: 0n,
      });
    return { db, store, ask, advance: (ms: number) => (t += ms) };
  };

  it('is born PENDING, decided once, and never deleted or rewritten', () => {
    const { db, store, ask } = setup();
    const a = ask();
    assert.equal(a.status, 'PENDING');
    assert.equal(Date.parse(a.expiresAt) - Date.parse(a.requestedAt), 60_000);
    assert.throws(() => ask(), /UNIQUE/, 'one request per payment');
    const yes = store.decide(a.id, 'APPROVED', '  looks right  ');
    assert.equal(yes.status, 'APPROVED');
    assert.equal(yes.decidedBy, 'owner');
    assert.equal(yes.note, 'looks right');
    assert.throws(
      () => store.decide(a.id, 'REJECTED'),
      (e: unknown) => e instanceof ApprovalError && e.code === 'ALREADY_DECIDED',
    );
    assert.throws(
      () => db.prepare("UPDATE payment_approvals SET status = 'REJECTED'").run(),
      /decided once/,
    );
    assert.throws(() => db.prepare('DELETE FROM payment_approvals').run(), /never deleted/);
    assert.equal(store.expire(a.id, 'timeout'), null, 'a decided request cannot expire');
  });

  it('expires when nobody answers in time, and a late answer is refused', async () => {
    const { store, ask, advance } = setup();
    const a = ask();
    advance(61_000);
    assert.throws(
      () => store.decide(a.id, 'APPROVED'),
      (e: unknown) => e instanceof ApprovalError && e.code === 'EXPIRED',
    );
    assert.equal(store.get(a.id)?.status, 'EXPIRED');
    assert.equal(store.get(a.id)?.decidedBy, 'timeout');
  });

  it('wait() returns the answer, or expires the request at its deadline', async () => {
    const { store, ask, advance } = setup();
    const a = ask();
    let polls = 0;
    const done = await store.wait(a.id, {
      sleep: async () => {
        polls += 1;
        advance(10_000);
      },
    });
    assert.equal(done.status, 'EXPIRED');
    assert.ok(polls >= 6 && polls <= 7, `polled ${polls} times`);
    assert.throws(
      () => new ApprovalStore(openDatabase(':memory:').db, { timeoutSec: 5 }),
      /30 to 3600/,
    );
  });

  it('a restart expires every open request', () => {
    const { store, ask } = setup();
    ask();
    assert.equal(store.expireAllPending('restart').length, 1);
    assert.equal(store.list({ status: 'PENDING' }).length, 0);
    assert.equal(store.list({ status: 'EXPIRED' })[0]?.decidedBy, 'restart');
  });
});

// ── the orchestrator in each mode ─────────────────────────────────────────

describe('orchestrator: Autonomous mode stays the default (D-066)', () => {
  it('no approval is asked; both payments settle exactly as before', async () => {
    const h = harness({
      plan: () => planJson([BUY_KEV, BUY_OSV]),
      analysis: () => analysisJson(['CVE-2026-1001']),
      approver: () => {
        throw new Error('no approval must be asked in autonomous mode');
      },
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(eventsOf(h.db, run.id, 'PAYMENT_APPROVAL_REQUESTED').length, 0);
    assert.equal(eventsOf(h.db, run.id, 'PAYMENT_SETTLED').length, 2);
    assert.equal(h.approvalStore.list().length, 0);
    const policy = eventsOf(h.db, run.id, 'RUN_STARTED')[0]?.payload['policy'] as Record<
      string,
      unknown
    >;
    assert.equal(policy['approvalMode'], 'autonomous');
  });
});

describe('orchestrator: Human approval mode (mock, D-066)', () => {
  it('approve: the request and the answer are run events, and the payment is signed only after the yes', async () => {
    const order: string[] = [];
    const h = humanHarness({
      approver: (a) => {
        order.push(`asked ${a.provider} ${a.amountAtomic}`);
        return 'approve';
      },
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'SUCCEEDED');
    assert.deepEqual(order, [`asked ${KEV.ensName} 100000`, `asked ${OSV.ensName} 120000`]);
    const seq = types(h.db, run.id);
    const firstAsk = seq.indexOf('PAYMENT_APPROVAL_REQUESTED');
    const firstDecided = seq.indexOf('PAYMENT_APPROVAL_DECIDED');
    const firstAuthorized = seq.indexOf('PAYMENT_AUTHORIZED');
    assert.ok(firstAsk >= 0 && firstAsk < firstDecided && firstDecided < firstAuthorized);
    assert.deepEqual(
      eventsOf(h.db, run.id, 'PAYMENT_APPROVAL_DECIDED').map((e) => e.payload['decision']),
      ['APPROVED', 'APPROVED'],
    );
    // the quote was asked again after the yes: two 402s per provider, then the signature
    const kev = h.log.filter((l) => l === '402 kev' || l.startsWith(`sign ${KEV.payTo}`));
    assert.deepEqual(kev, ['402 kev', '402 kev', `sign ${KEV.payTo} 100000`]);
    assert.equal(eventsOf(h.db, run.id, 'PAYMENT_SETTLED').length, 2);
    assert.deepEqual(
      h.approvalStore.listByRun(run.id).map((a) => [a.status, a.decidedBy]),
      [
        ['APPROVED', 'owner'],
        ['APPROVED', 'owner'],
      ],
    );
  });

  it('reject: never signed, the intent ends FAILED (APPROVAL_REJECTED), the run goes on', async () => {
    const h = humanHarness({
      approver: (a) => (a.provider === KEV.ensName ? 'reject' : 'approve'),
      analysis: () => analysisJson(['GHSA-aaaa-bbbb-cccc']),
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'SUCCEEDED', 'the approved osv purchase still feeds the brief');
    assert.ok(!h.log.some((l) => l.startsWith(`sign ${KEV.payTo}`)), 'kev was never signed');
    const kev = (await h.store.listByRun(run.id)).find((p) => p.provider === KEV.ensName);
    assert.equal(kev?.status, 'FAILED');
    assert.equal(kev?.errorCode, 'APPROVAL_REJECTED');
    assert.equal(kev?.transactionId, null);
    const skipped = eventsOf(h.db, run.id, 'PURCHASE_SKIPPED').map((e) => e.payload['code']);
    assert.deepEqual(skipped, ['APPROVAL_REJECTED']);
    const summary = summarizeRun(listRunEvents(h.db, run.id), run.status, 'mock');
    assert.match(
      summary.stages.find((s) => s.stage === 'payments')?.detail ?? '',
      /2 sent to the owner for approval/,
    );
  });

  it('no answer in time: APPROVAL_EXPIRED, never signed', async () => {
    const h = humanHarness({ plan: () => planJson([BUY_KEV]), approver: () => 'wait' });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'FAILED', 'no data was bought');
    assert.ok(!h.log.some((l) => l.startsWith('sign')));
    const [p] = await h.store.listByRun(run.id);
    assert.equal(p?.errorCode, 'APPROVAL_EXPIRED');
    assert.equal(h.approvalStore.listByRun(run.id)[0]?.decidedBy, 'timeout');
  });

  it('at or below the threshold, the agent pays on its own', async () => {
    const h = humanHarness(
      { approver: (a) => (a.provider === OSV.ensName ? 'approve' : 'reject') },
      { above: 100_000n },
    );
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'SUCCEEDED');
    const asked = h.approvalStore.listByRun(run.id).map((a) => a.provider);
    assert.deepEqual(asked, [OSV.ensName], 'kev (100000) is not above the threshold');
    assert.equal(eventsOf(h.db, run.id, 'PAYMENT_SETTLED').length, 2);
  });

  it('a pause saved while a payment waits wins: PAYMENTS_PAUSED, never signed', async () => {
    const h = humanHarness({
      plan: () => planJson([BUY_KEV]),
      approver: (_a, hooks) => {
        hooks.pause();
        return 'approve';
      },
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.ok(!h.log.some((l) => l.startsWith('sign')));
    const [p] = await h.store.listByRun(run.id);
    assert.equal(p?.errorCode, 'PAYMENTS_PAUSED');
  });

  it('a quote changed after the yes is not paid: APPROVAL_QUOTE_CHANGED', async () => {
    const h = humanHarness({
      plan: () => planJson([BUY_KEV]),
      approver: (_a, hooks) => {
        hooks.requote('kev', '999999');
        return 'approve';
      },
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.ok(!h.log.some((l) => l.startsWith('sign')));
    const [p] = await h.store.listByRun(run.id);
    assert.equal(p?.errorCode, 'APPROVAL_QUOTE_CHANGED');
  });

  it('a process that cannot ask (no approval store) never pays autonomously instead', async () => {
    const h = humanHarness({ plan: () => planJson([BUY_KEV]), noApprovalStore: true });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.ok(!h.log.some((l) => l.startsWith('sign')));
    const [p] = await h.store.listByRun(run.id);
    assert.equal(p?.status, 'FAILED');
    assert.equal(p?.errorCode, 'APPROVAL_UNAVAILABLE');
  });

  it('approval events belong to the payments stage; a request is a warning, a yes a success', () => {
    const ask = { type: 'PAYMENT_APPROVAL_REQUESTED', payload: {} };
    const yes = { type: 'PAYMENT_APPROVAL_DECIDED', payload: { decision: 'APPROVED' } };
    const no = { type: 'PAYMENT_APPROVAL_DECIDED', payload: { decision: 'REJECTED' } };
    assert.equal(stageOf(ask), 'payments');
    assert.equal(severityOf(ask), 'warning');
    assert.equal(severityOf(yes), 'success');
    assert.equal(severityOf(no), 'warning');
  });
});

describe('orchestrator: per-provider daily caps and the self-purchase guard (mock, D-066)', () => {
  it('a provider over its daily cap is refused by the firewall, nothing signed', async () => {
    const h = harness({
      plan: () => planJson([BUY_KEV]),
      analysis: () => analysisJson(['CVE-2026-1001']),
    });
    h.policyStore.save({
      limits: { ...LIMITS, providerDailyCaps: { [KEV.ensName]: 150_000n } },
      expectedVersion: null,
      reason: null,
    });
    const first = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(eventsOf(h.db, first.run.id, 'PAYMENT_SETTLED').length, 1, '100000 ≤ 150000');
    const second = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.deepEqual(
      eventsOf(h.db, second.run.id, 'PAYMENT_REFUSED').map((e) => e.payload['code']),
      ['OVER_PROVIDER_DAILY_BUDGET'],
    );
    assert.equal(h.log.filter((l) => l.startsWith(`sign ${KEV.payTo}`)).length, 1);
  });

  it('a provider paid to the agent’s own earnings account is never bought (SELF_PROVIDER)', async () => {
    const h = harness({
      plan: () => planJson([BUY_KEV, BUY_OSV]),
      analysis: () => analysisJson(['CVE-2026-1001']),
      earningsAccount: KEV.payTo,
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    const skipped = eventsOf(h.db, run.id, 'PURCHASE_SKIPPED');
    assert.deepEqual(
      skipped.map((e) => [e.payload['provider'], e.payload['code']]),
      [[KEV.ensName, 'SELF_PROVIDER']],
    );
    assert.ok(!h.log.includes('402 kev'), 'not even quoted');
    assert.equal(eventsOf(h.db, run.id, 'PAYMENT_SETTLED').length, 1);
  });
});

// ── earnings from the Mirror Node ─────────────────────────────────────────

describe('earnings (D-066)', () => {
  const EARN = '0.0.7777001';
  const FAC = '0.0.7162784';
  const sale = (sec: number, amount: bigint, buyer: string) => ({
    transactionId: `${FAC}-${sec}-000000001`,
    result: 'SUCCESS',
    name: 'CRYPTOTRANSFER',
    consensusTimestamp: `${sec + 2}.000000001`,
    chargedTxFee: 260_000n,
    transfers: [
      { account: buyer, amount: -amount },
      { account: EARN, amount },
      { account: FAC, amount: -260_000n },
      { account: '0.0.802', amount: 260_000n },
    ],
  });

  it('counts x402 credits into the account; flags a purchase by the agent’s own payer', () => {
    const own = {
      ...sale(3, 1n, EARN),
      transactionId: `${EARN}-3-000000001`,
      transfers: [
        { account: EARN, amount: -50n },
        { account: '0.0.5', amount: 50n },
      ],
    };
    const failed = { ...sale(4, 300_000n, '0.0.123'), result: 'INSUFFICIENT_PAYER_BALANCE' };
    const list = salesOf(
      [sale(1, 200_000n, '0.0.123'), sale(2, 200_000n, PAYER), own, failed],
      EARN,
      PAYER,
    );
    assert.deepEqual(
      list.map((x) => [x.tinybars, x.buyer, x.fromOwnPayer]),
      [
        [200_000n, '0.0.123', false],
        [200_000n, PAYER, true],
      ],
    );
  });

  it('reads the Mirror Node once per minute and totals outside revenue separately', async () => {
    let calls = 0;
    let t = NOW.getTime();
    const reader = new EarningsReader({
      account: EARN,
      ownPayer: PAYER,
      now: () => new Date(t),
      mirror: {
        listAccountTransfers: async () => {
          calls += 1;
          return [sale(1, 200_000n, '0.0.123'), sale(2, 200_000n, PAYER)];
        },
      },
    });
    const r = await reader.read();
    assert.equal(r.tinybars, 400_000n);
    assert.equal(r.outsideTinybars, 200_000n);
    await reader.read();
    assert.equal(calls, 1);
    t += 61_000;
    await reader.read();
    assert.equal(calls, 2);
  });
});

// ── the API ───────────────────────────────────────────────────────────────

const servers: Server[] = [];
const dirs: string[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function api(o: { earnings?: boolean } = {}) {
  const h = humanHarness({
    plan: () => planJson([BUY_KEV]),
    // the owner answers through the API below; the harness only waits, in real time
    approvalRealWait: true,
    approvalTimeoutSec: 600,
  });
  const runner = new TaskRunner(h.orchestrator, { maxPending: 3 });
  const root = mkdtempSync(`${tmpdir()}/evidence-`);
  dirs.push(root);
  const server = createServer(
    (req, res) =>
      void createApi({
        db: h.db,
        runner,
        payments: h.store,
        inference: h.ledger,
        accessCode: CODE,
        hashscan: (tx) => `https://hashscan.io/testnet/transaction/${encodeURIComponent(tx)}`,
        migration: 9,
        evidenceRoot: root,
        publicConfig: PUBLIC_CONFIG,
        policy: h.policyStore,
        mode: 'mock',
        schedules: h.scheduleStore,
        approvals: h.approvalStore,
        earnings:
          o.earnings === true
            ? {
                account: '0.0.7777001',
                read: async () => ({
                  account: '0.0.7777001',
                  fromSeconds: 0,
                  toSeconds: 7 * 86_400,
                  tinybars: 200_000n,
                  outsideTinybars: 0n,
                  sales: [
                    {
                      transactionId: '0.0.9999901-1-000000001',
                      consensusTimestamp: '3.000000001',
                      tinybars: 200_000n,
                      buyer: PAYER,
                      fromOwnPayer: true,
                    },
                  ],
                  readAt: NOW.toISOString(),
                }),
              }
            : null,
        deployment: () => ({ erc8004: { identityRegistry: '0x8004' }, setups: null }),
        corsOrigin: null,
        trustProxyHops: 1,
        secureCookies: false,
        limits: {},
        now: () => NOW.getTime(),
      }).handler(req, res),
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let ip = 0;
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('x-forwarded-for', `198.51.100.${++ip % 250}`);
    return fetch(`${base}${path}`, { ...init, headers });
  };
  return { h, runner, call };
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const auth = { authorization: `Bearer ${CODE}`, 'content-type': 'application/json' };

async function waitFor<T>(fn: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 400; i += 1) {
    const v = fn();
    if (v !== null && v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('API: approvals, earnings and the brief for sale (mock, D-066)', () => {
  it('a waiting payment shows in health, config and the task; the owner approves it with the access code', async () => {
    const t = await api();
    const res = await t.call('/api/tasks', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ watchlist: 'OpenSSL' }),
    });
    assert.equal(res.status, 202);
    const taskId = ((await json(res))['task'] as { id: string }).id;
    const pending = await waitFor(
      () => t.h.approvalStore.list({ status: 'PENDING' })[0],
      'an approval request',
    );
    const health = await json(await t.call('/api/health'));
    assert.deepEqual(health['approvals'], { pending: 1 });
    const config = await json(await t.call('/api/config'));
    assert.equal((config['policy'] as Record<string, unknown>)['approvalMode'], 'human');
    const list = await json(await t.call('/api/approvals?status=PENDING'));
    assert.equal(list['mode'], 'human');
    assert.equal((list['approvals'] as unknown[]).length, 1);
    const detail = await json(await t.call(`/api/tasks/${taskId}`));
    assert.equal(((detail['approvals'] as { status: string }[])[0] ?? {}).status, 'PENDING');

    // without the code, or with a bad body: refused, still pending
    const noCode = await t.call(`/api/approvals/${pending.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(noCode.status, 401);
    const bad = await t.call(`/api/approvals/${pending.id}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ decision: 'yes please', payTo: '0.0.666' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(t.h.approvalStore.get(pending.id)?.status, 'PENDING');

    const ok = await t.call(`/api/approvals/${pending.id}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ decision: 'approve', note: 'checked' }),
    });
    assert.equal(ok.status, 200);
    const again = await t.call(`/api/approvals/${pending.id}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ decision: 'reject' }),
    });
    assert.equal(again.status, 409);
    await t.runner.idle();
    const after = await json(await t.call(`/api/tasks/${taskId}`));
    assert.equal(((after['task'] as { status: string }) ?? {}).status, 'SUCCEEDED');
    assert.equal(((after['payments'] as { status: string }[])[0] ?? {}).status, 'SETTLED');
    const unknown = await t.call('/api/approvals/00000000-0000-4000-8000-000000000999', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(unknown.status, 404);
    assert.equal((await t.call('/api/approvals?status=MAYBE')).status, 400);

    // the brief for sale: the latest finished brief, as JSON
    const brief = await json(await t.call('/api/briefs/latest'));
    assert.equal(brief['runId'], taskId);
    assert.equal(brief['environment'], 'mock');
    assert.match(String(brief['markdown']), /Threat brief/);
  });

  it('PUT /api/policy saves the approval mode and per-provider caps; leaving them out keeps them', async () => {
    const t = await api();
    const put = (body: unknown) =>
      t.call('/api/policy', { method: 'PUT', headers: auth, body: JSON.stringify(body) });
    const base = {
      maxPerPayment: '200000',
      maxPerRun: '500000',
      maxPerDay: '2000000',
      maxPaymentsPerRun: 3,
      paymentsPaused: false,
    };
    const r = await put({
      ...base,
      approvalMode: 'autonomous',
      approvalAboveTinybars: '0',
      providerDailyCaps: { [KEV.ensName]: '300000' },
      expectedVersion: 1,
    });
    assert.equal(r.status, 200);
    const p = await json(r);
    const eff = p['effective'] as Record<string, unknown>;
    assert.equal(eff['approvalMode'], 'autonomous');
    assert.deepEqual(eff['providerDailyCaps'], { [KEV.ensName]: '300000' });
    const kept = await json(await put({ ...base, expectedVersion: 2 }));
    assert.deepEqual((kept['effective'] as Record<string, unknown>)['providerDailyCaps'], {
      [KEV.ensName]: '300000',
    });
    const bad = await put({ ...base, approvalMode: 'maybe', expectedVersion: 3 });
    assert.equal(bad.status, 400);
  });

  it('earnings: disabled says so; enabled lists sales with HashScan links and flags self-tests', async () => {
    const off = await api();
    assert.deepEqual(await json(await off.call('/api/earnings')), {
      enabled: false,
      account: null,
    });
    const on = await api({ earnings: true });
    const e = await json(await on.call('/api/earnings'));
    assert.equal(e['enabled'], true);
    assert.equal(e['tinybars'], '200000');
    assert.equal(e['outsideTinybars'], '0');
    const sales = e['sales'] as { fromOwnPayer: boolean; hashscan: string }[];
    assert.equal(sales[0]?.fromOwnPayer, true);
    assert.match(sales[0]?.hashscan ?? '', /^https:\/\/hashscan\.io\/testnet\/transaction\//);
    const providers = await json(await on.call('/api/providers'));
    assert.deepEqual(providers['identity'], { identityRegistry: '0x8004' });
  });

  it('no finished brief yet: 404 NO_BRIEF', async () => {
    const t = await api();
    const r = await t.call('/api/briefs/latest');
    assert.equal(r.status, 404);
    assert.equal((await json(r))['error'], 'NO_BRIEF');
  });
});

describe('run summary while a payment waits for approval (D-066)', () => {
  it('the payments stage is in progress, not failed, and nothing later is claimed', async () => {
    const { summarizeRun } = await import('../src/api/run-summary.ts');
    const at = '2026-10-29T10:00:00.000Z';
    const ev = (seq: number, type: string, payload: Record<string, unknown>) => ({
      runId: 'r',
      seq,
      type: type as never,
      payload,
      at,
    });
    const events = [
      ev(0, 'RUN_STARTED', { environment: 'live' }),
      ev(1, 'PROVIDERS_DISCOVERED', { providers: [{}], blockNumber: '1' }),
      ev(2, 'CATALOG_READ', { ok: true }),
      ev(3, 'PLAN_CREATED', { purchases: [{}] }),
      ev(4, 'PAYMENT_APPROVAL_REQUESTED', { amountAtomic: '1' }),
    ];
    const waiting = summarizeRun(events, 'RUNNING', 'live');
    const stage = (s: typeof waiting, name: string) => s.stages.find((x) => x.stage === name);
    assert.equal(stage(waiting, 'payments')?.outcome, 'running');
    assert.match(stage(waiting, 'payments')?.detail ?? '', /waiting for the owner/);
    assert.equal(stage(waiting, 'verification')?.outcome, 'not-reached');
    // rejected: no longer waiting, and the outcome is decided by what happened
    const rejected = summarizeRun(
      [...events, ev(5, 'PAYMENT_APPROVAL_DECIDED', { decision: 'REJECTED' })],
      'RUNNING',
      'live',
    );
    assert.notEqual(stage(rejected, 'payments')?.outcome, 'running');
  });
});
