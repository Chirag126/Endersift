// Class: mock (scheduler and delta through the MOCK orchestrator harness) and
// unit (pure delta, due time, store). NOT live verification: the live proof is
// two dated scheduled runs (plan row 28), checked by `pnpm schedule:evidence`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunEvent } from '@agent-economy/core/domain';
import { TaskRunner } from '../src/api/task-runner.ts';
import { getReport, getRun, listRunEvents } from '../src/db/repositories.ts';
import { computeDelta, parseDigest, watchlistKey, type Digest } from '../src/orchestrator/delta.ts';
import { formatRunAfter, parseRunAfter } from '../src/schedule/schedule-store.ts';
import { CATCH_UP_WINDOW_MIN, Scheduler, dueToday, nextRunAt } from '../src/schedule/scheduler.ts';
import { seedDailyBrief } from '../src/schedule/seed.ts';
import {
  BUY_KEV,
  BUY_OSV,
  POLICY,
  analysisJson,
  harness,
  intel,
  item,
  planJson,
} from './support/orchestrator-harness.ts';

const WATCHLIST = ['OpenSSL', 'lodash@4.17.21 (npm)'];
const at = (iso: string) => new Date(iso);
const event = (db: Parameters<typeof listRunEvents>[0], runId: string, type: string) =>
  listRunEvents(db, runId).find((e: RunEvent) => e.type === type)?.payload ?? {};

describe('delta (unit)', () => {
  const d = (items: [string, string | null][]): Digest => ({
    items: items.map(([id, priority]) => ({
      id,
      severity: 'high',
      exploited: false,
      priority: priority as 'p1' | 'p2' | 'p3' | null,
    })),
  });

  it('new, gone, priority changes and unchanged, by advisory ID (case-insensitive)', () => {
    const delta = computeDelta(
      {
        runId: 'r1',
        at: '2026-10-28T00:20:00.000Z',
        digest: d([
          ['CVE-1', 'p2'],
          ['CVE-2', 'p1'],
          ['GHSA-x', null],
        ]),
      },
      d([
        ['cve-1', 'p1'],
        ['GHSA-X', null],
        ['CVE-9', 'p3'],
      ]),
    );
    assert.deepEqual(
      delta.added.map((i) => i.id),
      ['CVE-9'],
    );
    assert.deepEqual(
      delta.gone.map((i) => i.id),
      ['CVE-2'],
    );
    assert.deepEqual(delta.changed, [{ id: 'cve-1', from: 'p2', to: 'p1' }]);
    assert.equal(delta.unchanged, 1);
  });

  it('reads digests defensively and matches watchlists by their items', () => {
    assert.equal(parseDigest(null), null);
    assert.equal(parseDigest({ items: [{ id: '' }] }), null);
    assert.deepEqual(parseDigest({ items: [{ id: 'CVE-1', priority: 'p9' }] }), {
      items: [{ id: 'CVE-1', severity: 'unknown', exploited: false, priority: null }],
    });
    assert.equal(watchlistKey(['OpenSSL', ' lodash ']), watchlistKey(['LODASH', 'openssl']));
    assert.notEqual(watchlistKey(['OpenSSL']), watchlistKey(['OpenSSL', 'nginx']));
  });
});

describe('due time (unit)', () => {
  it('a schedule is due after its UTC time, today only', () => {
    const s = { runAfterMinute: 15 };
    assert.deepEqual(dueToday(s, at('2026-10-28T00:14:59.000Z')), {
      day: '2026-10-28',
      dueAt: '2026-10-28T00:15:00.000Z',
      due: false,
    });
    assert.equal(dueToday(s, at('2026-10-28T23:59:00.000Z')).due, true);
    assert.equal(
      nextRunAt({ ...s, enabled: true }, at('2026-10-28T10:00:00.000Z'), true),
      '2026-10-29T00:15:00.000Z',
    );
    assert.equal(
      nextRunAt({ ...s, enabled: true }, at('2026-10-28T00:01:00.000Z'), false),
      '2026-10-28T00:15:00.000Z',
    );
    assert.equal(nextRunAt({ ...s, enabled: false }, at('2026-10-28T00:01:00.000Z'), false), null);
    assert.equal(parseRunAfter('00:15'), 15);
    assert.equal(parseRunAfter('24:00'), null);
    assert.equal(parseRunAfter('7:5'), null);
    assert.equal(formatRunAfter(615), '10:15');
  });
});

/** The harness behind a real TaskRunner, and a scheduler on a controllable clock. */
function setup(o: { analysis?: () => string; bodies?: Record<string, unknown> } = {}) {
  const h = harness({
    plan: () => planJson([BUY_KEV, BUY_OSV]),
    analysis: o.analysis ?? (() => analysisJson(['CVE-2026-1001', 'GHSA-aaaa-bbbb-cccc'])),
    ...(o.bodies === undefined ? {} : { paidBody: o.bodies }),
  });
  const runner = new TaskRunner(h.orchestrator);
  let clock = at('2026-10-28T00:10:00.000Z');
  const lines: string[] = [];
  const scheduler = new Scheduler({
    db: h.db,
    store: h.scheduleStore,
    submit: (request, budget, beforeStart) =>
      runner.submit(request, budget, { origin: 'scheduler', beforeStart }),
    now: () => clock,
    log: (l) => lines.push(l),
  });
  return {
    h,
    runner,
    scheduler,
    lines,
    setClock: (iso: string) => {
      clock = at(iso);
    },
  };
}

const schedule = (t: ReturnType<typeof setup>, over: Partial<{ budget: bigint }> = {}) =>
  t.h.scheduleStore.create({
    watchlist: WATCHLIST,
    budget: over.budget ?? 300_000n,
    runAfterMinute: 15,
    enabled: true,
  });

describe('a host that wipes its database (D-062)', () => {
  it('catches up only within the window after the time; nextRunAt says tomorrow after it', async () => {
    const t = setup();
    schedule(t);
    const windowed = (iso: string) =>
      new Scheduler({
        db: t.h.db,
        store: t.h.scheduleStore,
        submit: (request, budget, beforeStart) =>
          t.runner.submit(request, budget, { origin: 'scheduler', beforeStart }),
        now: () => at(iso),
        catchUpWindowMin: CATCH_UP_WINDOW_MIN,
      });
    // woken at 10:00 by a visitor, long after 00:15: the day's brief is not run (again)
    assert.equal(windowed('2026-10-28T10:00:00.000Z').tick()[0]?.result, 'window-passed');
    assert.equal(t.h.scheduleStore.runsOf(t.h.scheduleStore.list()[0]?.id ?? '').length, 0);
    // woken at 02:00 by the daily ping, inside 00:15 + 120 min: it runs
    assert.equal(windowed('2026-10-28T02:00:00.000Z').tick()[0]?.result, 'started');
    await t.runner.idle();
    const s = { runAfterMinute: 15, enabled: true };
    assert.equal(
      nextRunAt(s, at('2026-10-28T03:00:00.000Z'), false, CATCH_UP_WINDOW_MIN),
      '2026-10-29T00:15:00.000Z',
    );
    assert.equal(
      nextRunAt(s, at('2026-10-28T01:00:00.000Z'), false, CATCH_UP_WINDOW_MIN),
      '2026-10-28T01:00:00.000Z',
    );
    assert.equal(nextRunAt(s, at('2026-10-28T03:00:00.000Z'), false), '2026-10-28T03:00:00.000Z');
  });

  it('the configured daily brief is created once, enabled, and validated', () => {
    const t = setup();
    const input = {
      watchlist: 'OpenSSL, lodash@4.17.21 (npm)',
      runAfter: '00:15',
      budget: 300_000n,
    };
    const first = seedDailyBrief(t.h.scheduleStore, input, POLICY.maxPerRun);
    assert.equal(first.created, true);
    assert.deepEqual(first.schedule.watchlist, WATCHLIST);
    assert.equal(first.schedule.runAfterMinute, 15);
    assert.equal(first.schedule.enabled, true);
    const again = seedDailyBrief(t.h.scheduleStore, input, POLICY.maxPerRun);
    assert.equal(again.created, false, 'a restart on a kept database adds nothing');
    assert.equal(again.schedule.id, first.schedule.id);
    assert.equal(t.h.scheduleStore.list().length, 1);
    assert.throws(
      () =>
        seedDailyBrief(
          t.h.scheduleStore,
          { ...input, budget: POLICY.maxPerRun + 1n },
          POLICY.maxPerRun,
        ),
      /DAILY_BRIEF_BUDGET_TINYBARS must be between 1 and/,
    );
    assert.throws(
      () => seedDailyBrief(t.h.scheduleStore, { ...input, runAfter: '24:00' }, POLICY.maxPerRun),
      /DAILY_BRIEF_RUN_AFTER/,
    );
    assert.throws(
      () => seedDailyBrief(t.h.scheduleStore, { ...input, watchlist: ' , ' }, POLICY.maxPerRun),
      /DAILY_BRIEF_WATCHLIST/,
    );
  });
});

describe('scheduler (mock)', () => {
  it('starts one run per UTC day after its time, with its own budget, recorded as scheduled', async () => {
    const t = setup();
    const s = schedule(t);
    assert.equal(t.scheduler.tick()[0]?.result, 'not-due', 'before 00:15 UTC');
    t.setClock('2026-10-28T00:16:00.000Z');
    const [first] = t.scheduler.tick();
    assert.equal(first?.result, 'started');
    assert.equal(t.scheduler.tick()[0]?.result, 'already-ran', 'a second tick the same day');
    await t.runner.idle();
    const run = getRun(t.h.db, first?.runId ?? '');
    assert.equal(run?.status, 'SUCCEEDED', run?.error ?? '');
    assert.equal(run?.trigger, 'scheduled');
    const started = event(t.h.db, run?.id ?? '', 'RUN_STARTED');
    assert.equal(started['origin'], 'scheduler');
    assert.equal((started['policy'] as Record<string, unknown>)['maxPerRun'], '300000');
    assert.deepEqual(
      t.h.scheduleStore.runsOf(s.id).map((r) => r.day),
      ['2026-10-28'],
    );
  });

  it('a restart the same day does not run again; a later start catches up today, never a missed day', async () => {
    const t = setup();
    const s = schedule(t);
    t.setClock('2026-10-28T00:20:00.000Z');
    t.scheduler.tick();
    await t.runner.idle();
    // a new scheduler (process restart) on the same database
    const again = new Scheduler({
      db: t.h.db,
      store: t.h.scheduleStore,
      submit: (request, budget, beforeStart) =>
        t.runner.submit(request, budget, { origin: 'scheduler', beforeStart }),
      now: () => at('2026-10-28T09:00:00.000Z'),
    });
    assert.equal(again.tick()[0]?.result, 'already-ran');
    // the server was down on the 29th and starts on the 30th at 07:00: only the 30th runs
    t.setClock('2026-10-30T07:00:00.000Z');
    assert.equal(t.scheduler.tick()[0]?.result, 'started');
    await t.runner.idle();
    assert.deepEqual(
      t.h.scheduleStore.runsOf(s.id).map((r) => r.day),
      ['2026-10-30', '2026-10-28'],
    );
  });

  it('kill switch: a due run is not claimed, the reason is noted, and it starts once payments resume', async () => {
    const t = setup();
    const s = schedule(t);
    t.h.policyStore.save({
      limits: {
        maxPerPayment: POLICY.maxPerPayment,
        maxPerRun: POLICY.maxPerRun,
        maxPerDay: POLICY.maxPerDay,
        maxPaymentsPerRun: POLICY.maxPaymentsPerRun,
        paymentsPaused: true,
      },
      expectedVersion: null,
      reason: null,
    });
    t.setClock('2026-10-28T00:30:00.000Z');
    const [skipped] = t.scheduler.tick();
    assert.equal(skipped?.result, 'skipped');
    assert.match(skipped?.reason ?? '', /^PAYMENTS_PAUSED/);
    assert.equal(t.h.scheduleStore.claimed(s.id, '2026-10-28'), null, 'not claimed');
    assert.match(t.h.scheduleStore.get(s.id)?.lastSkip ?? '', /^PAYMENTS_PAUSED/);
    t.scheduler.tick();
    assert.equal(t.lines.length, 1, 'the same reason is logged once');
    t.h.policyStore.save({
      limits: {
        maxPerPayment: POLICY.maxPerPayment,
        maxPerRun: POLICY.maxPerRun,
        maxPerDay: POLICY.maxPerDay,
        maxPaymentsPerRun: POLICY.maxPaymentsPerRun,
        paymentsPaused: false,
      },
      expectedVersion: 1,
      reason: null,
    });
    t.setClock('2026-10-28T10:00:00.000Z');
    assert.equal(t.scheduler.tick()[0]?.result, 'started');
    assert.equal(t.h.scheduleStore.get(s.id)?.lastSkip, null);
    await t.runner.idle();
  });

  it('a budget above the run budget in force is skipped (INVALID_BUDGET), never raised', () => {
    const t = setup();
    schedule(t, { budget: POLICY.maxPerRun + 1n });
    t.setClock('2026-10-28T00:30:00.000Z');
    const [r] = t.scheduler.tick();
    assert.equal(r?.result, 'skipped');
    assert.match(r?.reason ?? '', /^INVALID_BUDGET/);
  });

  it('two processes racing for the same day: the database lets one claim, the other run is cancelled', async () => {
    const t = setup();
    const s = schedule(t);
    t.setClock('2026-10-28T00:30:00.000Z');
    // the other process claims between our check and our claim
    const { run: theirs } = t.runner.submit(
      { trigger: 'scheduled', watchlist: WATCHLIST },
      300_000n,
      {
        origin: 'scheduler',
        beforeStart: (r) => t.h.scheduleStore.claim(s.id, '2026-10-28', r.id),
      },
    );
    const racing = new Scheduler({
      db: t.h.db,
      store: {
        ...t.h.scheduleStore,
        list: () => t.h.scheduleStore.list(),
        claimed: () => null, // stale read: it has not seen the claim
        claim: (id: string, day: string, runId: string) => t.h.scheduleStore.claim(id, day, runId),
        noteSkip: (id: string, reason: string | null) => t.h.scheduleStore.noteSkip(id, reason),
      } as unknown as typeof t.h.scheduleStore,
      submit: (request, budget, beforeStart) =>
        t.runner.submit(request, budget, { origin: 'scheduler', beforeStart }),
      now: () => at('2026-10-28T00:30:00.000Z'),
    });
    const [r] = racing.tick();
    assert.equal(r?.result, 'skipped');
    assert.match(r?.reason ?? '', /^ALREADY_CLAIMED/);
    await t.runner.idle();
    assert.equal(t.h.scheduleStore.claimed(s.id, '2026-10-28')?.runId, theirs.id);
    const cancelled = t.h.db
      .prepare("SELECT status, error FROM runs WHERE status = 'CANCELLED'")
      .all() as { status: string; error: string }[];
    assert.equal(cancelled.length, 1);
    assert.match(cancelled[0]?.error ?? '', /^DUPLICATE_SCHEDULED_RUN/);
  });
});

describe('the delta brief (mock)', () => {
  it('the second brief for a watchlist reports what changed since the first', async () => {
    let call = 0;
    const bodies: Record<string, unknown> = {};
    const t = setup({
      bodies,
      analysis: () => {
        call += 1;
        return call === 1
          ? analysisJson(['CVE-2026-1001', 'GHSA-aaaa-bbbb-cccc'])
          : // day 2: lodash is now P1, and a new lodash advisory appeared
            analysisJson(['GHSA-aaaa-bbbb-cccc', 'GHSA-dddd-eeee-ffff']);
      },
    });
    schedule(t);
    t.setClock('2026-10-28T00:20:00.000Z');
    const [day1] = t.scheduler.tick();
    await t.runner.idle();
    const first = day1?.runId ?? '';
    assert.match(
      getReport(t.h.db, first)?.markdown ?? '',
      /## Since the previous brief\n\nNo comparison: first brief for this watchlist/,
    );
    assert.equal(event(t.h.db, first, 'REPORT_WRITTEN')['delta'], null);

    // day 2: KEV no longer lists the OpenSSL CVE; OSV adds a second lodash advisory
    bodies['kev'] = intel('kev', []);
    bodies['osv'] = intel('osv', [
      ...(intel('osv').items ?? []),
      item('GHSA-dddd-eeee-ffff', {
        affected: [
          { ecosystem: 'npm', package: 'lodash', ranges: [{ introduced: '0', fixed: '4.17.23' }] },
        ],
      }),
    ]);
    t.setClock('2026-10-29T00:20:00.000Z');
    const [day2] = t.scheduler.tick();
    await t.runner.idle();
    const second = day2?.runId ?? '';
    assert.equal(getRun(t.h.db, second)?.status, 'SUCCEEDED', getRun(t.h.db, second)?.error ?? '');
    const delta = event(t.h.db, second, 'REPORT_WRITTEN')['delta'] as Record<string, unknown>;
    assert.equal(delta['previousRunId'], first);
    assert.deepEqual(delta['added'], ['GHSA-dddd-eeee-ffff']);
    assert.deepEqual(delta['gone'], ['CVE-2026-1001']);
    assert.deepEqual(delta['changed'], [{ id: 'GHSA-aaaa-bbbb-cccc', from: 'p2', to: 'p1' }]);
    const md = getReport(t.h.db, second)?.markdown ?? '';
    assert.match(
      md,
      /Compared with the brief of \d{4}-\d{2}-\d{2} \(run `[0-9a-f-]+`\): 1 new, 1 no longer in the analysed data, 1 priority change, 0 unchanged\./,
    );
    assert.match(md, /- GHSA-dddd-eeee-ffff \(high, P2\)/);
    assert.match(md, /- GHSA-aaaa-bbbb-cccc: P2 → P1/);
    assert.match(md, /- CVE-2026-1001 \(critical, in CISA KEV, P1\)/);
  });

  it('a different watchlist, or a previous run without an accepted analysis, is no baseline', async () => {
    let call = 0;
    const t = setup({
      analysis: () => {
        call += 1;
        return call === 1 ? '{"bad":true}' : analysisJson(['CVE-2026-1001', 'GHSA-aaaa-bbbb-cccc']);
      },
    });
    const a = await t.h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(a.run.status, 'FAILED', 'analysis rejected');
    assert.match(a.report ?? '', /No comparison: this run has no accepted analysis/);
    const b = await t.h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.match(b.report ?? '', /No comparison: first brief for this watchlist/);
    const c = await t.h.orchestrator.run({ trigger: 'manual', watchlist: ['OpenSSL'] });
    assert.match(c.report ?? '', /No comparison: first brief/);
  });
});
