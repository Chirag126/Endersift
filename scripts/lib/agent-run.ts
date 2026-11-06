/**
 * Pure helpers for `pnpm agent:run` (plan row 25): watchlist parsing and the
 * checks that decide whether a live run counts as end-to-end evidence. They
 * read only what the run recorded (run, events, payments with their history
 * and Mirror Node verifications, ledger rows, report), never the console.
 */
import type {
  InferenceCall,
  PaymentIntent,
  Run,
  RunEvent,
} from '../../packages/core/src/domain/index.ts';
import type {
  PaymentTransition,
  SettlementVerification,
} from '../../apps/server/src/payments/payment-store.ts';
import {
  WatchlistError,
  parseWatchlist as parseShared,
} from '../../apps/server/src/orchestrator/watchlist.ts';
import { UsageError } from './cli.ts';

/** The shared parser (apps/server), with CLI-style errors. */
export function parseWatchlist(raw: string): string[] {
  try {
    return parseShared(raw);
  } catch (error) {
    if (error instanceof WatchlistError) throw new UsageError(error.message);
    throw error;
  }
}

export interface PaymentDetail extends PaymentIntent {
  readonly history: readonly PaymentTransition[];
  readonly verifications: readonly SettlementVerification[];
}

export interface AgentRunRecord {
  readonly run: Run;
  readonly events: readonly RunEvent[];
  readonly payments: readonly PaymentDetail[];
  readonly calls: readonly InferenceCall[];
  readonly report: string | null;
  readonly ensBlock: bigint;
}

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function agentRunChecks(r: AgentRunRecord): {
  list: Check[];
  verified: boolean;
  settled: number;
} {
  const list: Check[] = [];
  const add = (name: string, ok: boolean, detail = '') => list.push({ name, ok, detail });
  const ev = (type: string) => r.events.filter((e) => e.type === type);

  add('run SUCCEEDED', r.run.status === 'SUCCEEDED', r.run.error ?? '');

  const seqs = r.events.map((e) => e.seq);
  add(
    'events gapless from RUN_STARTED to RUN_FINISHED',
    seqs.every((s, i) => s === i) &&
      r.events[0]?.type === 'RUN_STARTED' &&
      r.events.at(-1)?.type === 'RUN_FINISHED',
    `${r.events.length} events`,
  );

  const discovered = ev('PROVIDERS_DISCOVERED')[0]?.payload;
  const providerCount = Array.isArray(discovered?.['providers'])
    ? discovered['providers'].length
    : 0;
  add(
    'providers discovered on ENS at the pinned block',
    discovered?.['blockNumber'] === r.ensBlock.toString() && providerCount > 0,
    `block ${r.ensBlock}, ${providerCount} providers`,
  );
  add(
    'at least one provider catalog agrees with ENS',
    ev('CATALOG_READ').some((e) => e.payload['ok'] === true),
  );

  const callEvents = new Set(ev('INFERENCE_CALLED').map((e) => e.payload['requestId']));
  for (const purpose of ['PLAN', 'ANALYZE'] as const) {
    const c = r.calls.find((x) => x.purpose === purpose && x.status === 'SUCCEEDED');
    add(
      `0G ${purpose} call SUCCEEDED with a request ID in the events`,
      c !== undefined && c.requestId !== null && callEvents.has(c.requestId),
      c?.requestId ?? 'none',
    );
  }

  const settled = r.payments.filter((p) => p.status === 'SETTLED');
  add('at least one payment SETTLED', settled.length > 0, `${settled.length} settled`);
  const settledEvents = new Set(ev('PAYMENT_SETTLED').map((e) => e.payload['transactionId']));
  for (const p of settled) {
    const order = p.history.map((h) => h.to).join('>');
    add(
      `${p.provider}: tx ID persisted before sending, SETTLED from a Mirror Node verification`,
      p.transactionId !== null &&
        order === 'CREATED>AUTHORIZED>SIGNED>SUBMITTED>SETTLED' &&
        p.verifications.some(
          (v) => v.outcome === 'SETTLED' && v.transactionId === p.transactionId,
        ) &&
        settledEvents.has(p.transactionId),
      p.transactionId ?? '',
    );
  }
  const committed = r.payments
    .filter((p) => ['AUTHORIZED', 'SIGNED', 'SUBMITTED', 'SETTLED', 'UNKNOWN'].includes(p.status))
    .reduce((s, p) => s + BigInt(p.amountAtomic), 0n);
  const budget = r.events[0]?.payload['policy'] as { maxPerRun?: string } | undefined;
  add(
    'committed spend within the run budget',
    budget?.maxPerRun !== undefined && committed <= BigInt(budget.maxPerRun),
    `${committed} of ${budget?.maxPerRun ?? '?'} tinybars`,
  );

  const settledIds = new Set(settled.map((p) => p.id));
  add(
    'paid data fetched from a SETTLED purchase',
    ev('DATA_FETCHED').some(
      (e) => e.payload['paid'] === true && settledIds.has(String(e.payload['intentId'])),
    ),
  );
  add(
    'analysis accepted (no invented advisory IDs)',
    ev('ANALYSIS_COMPLETED').some((e) => e.payload['accepted'] === true),
  );

  const report = r.report ?? '';
  const ids = [
    ...settled.map((p) => p.transactionId ?? '-'),
    ...r.calls.filter((c) => c.status === 'SUCCEEDED').map((c) => c.requestId ?? '-'),
  ];
  add(
    'brief written, citing every settled tx ID and 0G request ID',
    report !== '' && ids.every((id) => report.includes(id)),
    `${report.length} chars`,
  );

  return { list, verified: list.every((c) => c.ok), settled: settled.length };
}
