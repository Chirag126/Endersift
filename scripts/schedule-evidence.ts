/**
 * LIVE evidence for the recurring brief (plan row 28): two scheduled runs of
 * one schedule on two different UTC days, each end-to-end verified, the later
 * one with a delta against the earlier brief. Reads the agent's database
 * (DATABASE_PATH) only; spends nothing.
 *
 *   pnpm api:start -- --allow-local-http       (scheduler inside; leave it running past the time)
 *   … next UTC day, after the schedule's time …
 *   pnpm schedule:evidence -- --save-evidence  [--schedule <id>]
 *
 * Checks, for the two most recent claimed days:
 *   - both runs SUCCEEDED, trigger scheduled, origin scheduler, environment live (recorded);
 *   - each started after that day's time (UTC) and at most one run per day;
 *   - each run's budget is the schedule's (or lower, if the policy in force is lower);
 *   - each is end-to-end verified by the server's rule (run-summary.ts, D-053):
 *     a settled, Mirror-Node-verified payment, no unknown outcome, an accepted
 *     0G analysis and a brief;
 *   - the later brief has a delta against an earlier brief for the same watchlist
 *     (the earlier scheduled run, unless a manual task with the same watchlist ran between).
 */
import { summarizeRun } from '../apps/server/src/api/run-summary.ts';
import { loadServerConfig } from '../apps/server/src/config.ts';
import { openDatabase } from '../apps/server/src/db/database.ts';
import { getReport, getRun, listRunEvents } from '../apps/server/src/db/repositories.ts';
import { watchlistKey } from '../apps/server/src/orchestrator/delta.ts';
import { SqliteInferenceLedger } from '../apps/server/src/ledger/inference-ledger.ts';
import { SqlitePaymentStore } from '../apps/server/src/payments/payment-store.ts';
import { ScheduleStore, formatRunAfter } from '../apps/server/src/schedule/schedule-store.ts';
import { dueToday } from '../apps/server/src/schedule/scheduler.ts';
import {
  UsageError,
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from './lib/cli.ts';

handleScriptErrors();

const source = loadLocalEnvSource();
const config = loadServerConfig(source);
const network = source['HEDERA_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet';
const { db } = openDatabase(config.databasePath);
const schedules = new ScheduleStore(db);
const payments = new SqlitePaymentStore(db);
const ledger = new SqliteInferenceLedger(db);

const wanted = argValue('--schedule');
const all = schedules.list();
const schedule =
  wanted === undefined ? all.find((s) => schedules.runsOf(s.id).length > 0) : schedules.get(wanted);
if (schedule === null || schedule === undefined)
  throw new UsageError(
    wanted === undefined
      ? 'no schedule has run yet: create one on the Daily brief page and let it run'
      : `no schedule ${wanted}`,
  );

type MaybeDelta = Record<string, unknown> | null;

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}`);
};

console.log(
  `scheduled briefs: schedule ${schedule.id} · ${schedule.watchlist.join(', ')} · after ${formatRunAfter(schedule.runAfterMinute)} UTC · budget ${schedule.budget} tinybars\n`,
);

const claims = schedules.runsOf(schedule.id, 30);
const days = claims.map((c) => c.day);
check('one claimed run per UTC day', new Set(days).size === days.length, days.join(', '));
const recent = claims.slice(0, 2).reverse(); // earlier first
check('two claimed UTC days', recent.length === 2 && recent[0]?.day !== recent[1]?.day);

const runs = await Promise.all(
  recent.map(async (c) => {
    const run = getRun(db, c.runId);
    const events = listRunEvents(db, c.runId);
    const summary = run === null ? null : summarizeRun(events, run.status, 'live');
    const started = events.find((e) => e.type === 'RUN_STARTED')?.payload ?? {};
    const policy = (started['policy'] ?? {}) as Record<string, unknown>;
    const written = events.find((e) => e.type === 'REPORT_WRITTEN')?.payload ?? {};
    const ps = await payments.listByRun(c.runId);
    const calls = await ledger.listCalls({ runId: c.runId });
    return {
      day: c.day,
      runId: c.runId,
      status: run?.status ?? null,
      trigger: run?.trigger ?? null,
      startedAt: run?.startedAt ?? null,
      dueAt: dueToday(schedule, new Date(`${c.day}T12:00:00.000Z`)).dueAt,
      environment: started['environment'] ?? null,
      origin: started['origin'] ?? null,
      budget: typeof policy['maxPerRun'] === 'string' ? policy['maxPerRun'] : null,
      policyVersion: policy['version'] ?? null,
      verdict: summary?.verdict ?? null,
      gaps: summary?.gaps ?? [],
      stages: summary?.stages.map((s) => `${s.stage}:${s.outcome}`) ?? [],
      ensBlock:
        events.find((e) => e.type === 'PROVIDERS_DISCOVERED')?.payload['blockNumber'] ?? null,
      payments: ps.map((p) => ({
        provider: p.provider,
        amountAtomic: p.amountAtomic,
        status: p.status,
        refusalCode: p.refusalCode,
        transactionId: p.transactionId,
        hashscan:
          p.transactionId === null
            ? null
            : `https://hashscan.io/${network}/transaction/${encodeURIComponent(p.transactionId)}`,
      })),
      inference: calls.map((x) => ({
        purpose: x.purpose,
        status: x.status,
        requestId: x.requestId,
        costNeuron: x.costNeuron,
        funding: x.funding,
        teeVerified: x.teeVerified,
      })),
      delta: written['delta'] ?? null,
      report: getReport(db, c.runId)?.markdown ?? null,
    };
  }),
);

for (const r of runs) {
  const tag = r.day;
  check(`${tag}: run SUCCEEDED`, r.status === 'SUCCEEDED', String(r.status));
  check(
    `${tag}: started by the scheduler`,
    r.trigger === 'scheduled' && r.origin === 'scheduler',
    `${String(r.trigger)}/${String(r.origin)}`,
  );
  check(`${tag}: live networks (recorded)`, r.environment === 'live', String(r.environment));
  check(
    `${tag}: started after ${formatRunAfter(schedule.runAfterMinute)} UTC that day`,
    r.startedAt !== null && r.startedAt >= r.dueAt && r.startedAt.slice(0, 10) === r.day,
    String(r.startedAt),
  );
  check(
    `${tag}: per-run budget within the schedule's`,
    r.budget !== null && BigInt(r.budget) <= schedule.budget,
    `${String(r.budget)} ≤ ${schedule.budget}`,
  );
  check(
    `${tag}: end-to-end verified (server rule)`,
    r.verdict === 'e2e-verified',
    r.gaps.length === 0 ? String(r.verdict) : r.gaps.join('; '),
  );
}
const [first, second] = runs;
const delta = (second?.delta ?? null) as MaybeDelta;
// the previous brief is the latest earlier run for the same watchlist (D-056): normally the
// earlier scheduled run, or a manual task for the same watchlist run in between
const previousId = delta === null ? null : String(delta['previousRunId']);
const previous = previousId === null ? null : getRun(db, previousId);
check(
  'the later brief has a delta against an earlier brief for the same watchlist',
  previous !== null &&
    second !== undefined &&
    watchlistKey(previous.watchlist) === watchlistKey(schedule.watchlist) &&
    previous.createdAt < (getRun(db, second.runId)?.createdAt ?? ''),
  previousId === null
    ? 'no delta'
    : `previous ${previousId}${previousId === first?.runId ? ' (the earlier scheduled run)' : ''}`,
);
check(
  'the later brief prints the comparison',
  (second?.report ?? '').includes('## Since the previous brief') &&
    (second?.report ?? '').includes(previousId ?? '\u0000'),
);

const verified = checks.length > 0 && checks.every((c) => c.ok);
console.log(
  verified
    ? `\nVERIFIED: two dated scheduled briefs (${days.slice(0, 2).reverse().join(', ')}), the second with a delta.`
    : '\nNOT VERIFIED: see the FAIL lines above.',
);

if (hasFlag('--save-evidence')) {
  const path = writeEvidence(
    'schedule',
    verified ? 'scheduled-briefs' : 'scheduled-briefs-attempt',
    {
      kind: 'scheduled-briefs-live',
      verified,
      generatedAt: new Date().toISOString(),
      schedule: {
        id: schedule.id,
        watchlist: schedule.watchlist,
        budget: schedule.budget.toString(),
        runAfterUtc: formatRunAfter(schedule.runAfterMinute),
      },
      checks,
      runs,
    },
  );
  console.log(`\nEvidence written to ${path}`);
}
db.close();
if (!verified) process.exitCode = 1;
