/**
 * Daily inference cap (plan row 18, D-040): pure accounting, so the rule is
 * deterministic and independent of model output, like the per-call cap.
 *
 * What a ledger row counts against its UTC day:
 *   REFUSED              0          (never sent)
 *   PENDING, UNKNOWN     worst case (sent or about to be; outcome not known)
 *   SUCCEEDED            billed cost
 *   FAILED               billed cost if the Router billed it, else 0
 *                        (Router error responses are not billed; reconciliation
 *                        against the usage history flags any that were)
 *
 * A call is allowed only if spent-today + its worst case <= the daily cap.
 * Because the worst case is reserved before sending, concurrent calls and a
 * crash between sending and recording can only make the count higher, never lower.
 */

export interface LedgerCharge {
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'REFUSED';
  readonly worstCaseNeuron: bigint | null;
  readonly costNeuron: bigint | null;
}

export function chargeOf(row: LedgerCharge): bigint {
  switch (row.status) {
    case 'REFUSED':
      return 0n;
    case 'PENDING':
    case 'UNKNOWN':
      // A reservation without a worst case cannot exist (schema CHECK); be conservative anyway.
      return row.worstCaseNeuron ?? row.costNeuron ?? 0n;
    case 'SUCCEEDED':
    case 'FAILED':
      return row.costNeuron ?? 0n;
  }
}

export function sumCharges(rows: readonly LedgerCharge[]): bigint {
  return rows.reduce((sum, r) => sum + chargeOf(r), 0n);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** UTC calendar day of an ISO timestamp: "2026-10-27T08:36:40.291Z" → "2026-10-27". */
export function utcDay(iso: string): string {
  if (!ISO.test(iso) || Number.isNaN(Date.parse(iso))) throw new Error(`not a UTC ISO timestamp`);
  return iso.slice(0, 10);
}

/** [start, end) of a UTC day as ISO strings, for range queries on created_at. */
export function utcDayBounds(day: string): { readonly start: string; readonly end: string } {
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`)))
    throw new Error('day must be YYYY-MM-DD');
  const start = new Date(`${day}T00:00:00.000Z`);
  if (start.toISOString().slice(0, 10) !== day) throw new Error('day must be a real date');
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export type DailyCapDecision =
  | { readonly ok: true; readonly spent: bigint; readonly remainingAfter: bigint }
  | {
      readonly ok: false;
      readonly code: 'DAILY_CAP_EXCEEDED';
      readonly spent: bigint;
      readonly reason: string;
    };

export function checkDailyCap(input: {
  readonly spent: bigint;
  readonly worstCase: bigint;
  readonly dailyCap: bigint;
}): DailyCapDecision {
  const { spent, worstCase, dailyCap } = input;
  if (worstCase < 0n || spent < 0n || dailyCap <= 0n) throw new Error('invalid cap inputs');
  if (spent + worstCase > dailyCap) {
    return {
      ok: false,
      code: 'DAILY_CAP_EXCEEDED',
      spent,
      reason: `spent today ${spent} + worst case ${worstCase} exceeds the daily cap ${dailyCap} neuron`,
    };
  }
  return { ok: true, spent, remainingAfter: dailyCap - spent - worstCase };
}
