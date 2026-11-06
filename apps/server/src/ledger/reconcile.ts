/**
 * Ledger ↔ Router usage reconciliation (plan row 18 acceptance: "rows match
 * dashboard usage"). Pure: compares ledger rows with usage-history entries
 * (the data the dashboard's Usage page shows) by request ID.
 *
 * Per ledger row:
 *   MATCH              entry found; cost, tokens, provider and model equal
 *   MISMATCH           entry found, at least one field differs (listed)
 *   BILLED_UNRECORDED  the row says "not billed" (Router error) but an entry exists
 *   MISSING_IN_ROUTER  billed row, no entry, and the row is inside the history window
 *   OUT_OF_WINDOW      billed row older than the oldest entry returned (history is paged)
 *   UNRESOLVED         PENDING or UNKNOWN: no request ID to match; counted at the worst case
 *   NOT_BILLED         REFUSED, or a Router error with no entry: nothing to match
 * Router entries inside the ledger's time span that no row claims are
 * UNLEDGERED: spending the ledger (and so the daily cap) did not see.
 *
 * The verdict is MATCH only when at least one row matched and nothing is
 * MISMATCH, BILLED_UNRECORDED or MISSING_IN_ROUTER. UNLEDGERED entries are
 * reported separately (strict mode fails on them), since calls made with the
 * older zg:* scripts are expected to appear there.
 */
import type { InferenceCall } from '@agent-economy/core/domain';
import type { UsageEntry } from '@agent-economy/zg';

export const ROW_OUTCOMES = [
  'MATCH',
  'MISMATCH',
  'BILLED_UNRECORDED',
  'MISSING_IN_ROUTER',
  'OUT_OF_WINDOW',
  'UNRESOLVED',
  'NOT_BILLED',
] as const;
export type RowOutcome = (typeof ROW_OUTCOMES)[number];

export interface FieldDiff {
  readonly field: string;
  readonly ledger: string;
  readonly router: string;
}

export interface RowReconciliation {
  readonly call: InferenceCall;
  readonly outcome: RowOutcome;
  readonly entry: UsageEntry | null;
  readonly diffs: readonly FieldDiff[];
}

export interface Reconciliation {
  readonly rows: readonly RowReconciliation[];
  readonly unledgered: readonly UsageEntry[];
  readonly counts: Readonly<Record<RowOutcome, number>>;
  /** Oldest entry the Router returned (history is paged), or null for none. */
  readonly windowStart: string | null;
  readonly verdict: 'MATCH' | 'MISMATCH' | 'NOTHING_TO_MATCH';
}

const lower = (v: string | null): string | null => (v === null ? null : v.toLowerCase());

function diffsOf(call: InferenceCall, e: UsageEntry): FieldDiff[] {
  const out: FieldDiff[] = [];
  const cmp = (field: string, ledger: string | null, router: string | null) => {
    if (ledger !== router)
      out.push({ field, ledger: ledger ?? '(none)', router: router ?? '(none)' });
  };
  cmp('cost_neuron', call.costNeuron, e.cost.toString());
  cmp('prompt_tokens', call.promptTokens?.toString() ?? null, e.inputTokens.toString());
  cmp('completion_tokens', call.completionTokens?.toString() ?? null, e.outputTokens.toString());
  cmp('provider', lower(call.provider), lower(e.provider));
  cmp('model', lower(call.model), lower(e.model));
  return out;
}

export function reconcileWithUsage(
  calls: readonly InferenceCall[],
  entries: readonly UsageEntry[],
): Reconciliation {
  const byRequest = new Map(entries.map((e) => [e.requestId, e]));
  const windowStart =
    entries.length === 0 ? null : entries.map((e) => e.createdAt).reduce((a, b) => (a < b ? a : b));
  const claimed = new Set<string>();
  const rows: RowReconciliation[] = [];

  for (const call of calls) {
    const entry = call.requestId === null ? undefined : byRequest.get(call.requestId);
    if (entry !== undefined) claimed.add(entry.requestId);
    const billed = call.costNeuron !== null;
    let outcome: RowOutcome;
    let diffs: FieldDiff[] = [];
    if (call.status === 'PENDING' || call.status === 'UNKNOWN') {
      outcome = entry === undefined ? 'UNRESOLVED' : 'BILLED_UNRECORDED';
    } else if (entry !== undefined) {
      if (billed) {
        diffs = diffsOf(call, entry);
        outcome = diffs.length === 0 ? 'MATCH' : 'MISMATCH';
      } else {
        outcome = entry.cost > 0n ? 'BILLED_UNRECORDED' : 'MATCH';
      }
    } else if (!billed) {
      outcome = 'NOT_BILLED';
    } else {
      outcome =
        windowStart !== null && call.createdAt >= windowStart
          ? 'MISSING_IN_ROUTER'
          : 'OUT_OF_WINDOW';
    }
    rows.push({ call, outcome, entry: entry ?? null, diffs });
  }

  const span = calls.map((c) => c.createdAt).sort();
  const first = span[0];
  // A little slack before the first row: the Router stamps entries a few
  // hundred milliseconds after our reservation timestamp, never before it by much.
  const from = first === undefined ? null : new Date(Date.parse(first) - 60_000).toISOString();
  const unledgered = entries.filter(
    (e) => !claimed.has(e.requestId) && from !== null && e.createdAt >= from,
  );

  const counts = Object.fromEntries(ROW_OUTCOMES.map((o) => [o, 0])) as Record<RowOutcome, number>;
  for (const r of rows) counts[r.outcome] += 1;
  const bad = counts.MISMATCH + counts.BILLED_UNRECORDED + counts.MISSING_IN_ROUTER;
  const verdict = bad > 0 ? 'MISMATCH' : counts.MATCH === 0 ? 'NOTHING_TO_MATCH' : 'MATCH';
  return { rows, unledgered, counts, windowStart, verdict };
}

/** Funding split of a usage entry, in the ledger's terms (credits only when credit_used > 0). */
export function fundingOf(e: UsageEntry): {
  creditUsedNeuron: bigint;
  depositUsedNeuron: bigint;
  funding: 'credits' | 'deposit' | 'mixed' | 'none';
} {
  const c = e.creditUsed > 0n;
  const d = e.depositUsed > 0n;
  return {
    creditUsedNeuron: e.creditUsed,
    depositUsedNeuron: e.depositUsed,
    funding: c && d ? 'mixed' : c ? 'credits' : d ? 'deposit' : 'none',
  };
}

/**
 * Billed but not yet taken from credits or the Router float: the Router pulls
 * it from the Payment Layer (D-039). Seen live: cost 753694000000000,
 * deposit_used 314542666666667 (the whole float), pending 439151333333333.
 */
export const pendingPortion = (e: UsageEntry): bigint => {
  const rest = e.cost - e.creditUsed - e.depositUsed;
  return rest > 0n ? rest : 0n;
};
