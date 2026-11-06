/**
 * The spending rules in plain words, and validation of a task's budget. The
 * budget is the one part of the policy a person changes per task: it can only
 * lower the configured run budget (runPolicy, D-048). Pure.
 */
import { hbar, parseHbar } from './format.ts';
import type { ApprovalMode, OwnerLimits, PublicConfig } from './types.ts';

export type BudgetCheck =
  | { readonly ok: true; readonly tinybars: bigint }
  | { readonly ok: false; readonly message: string };

export function checkBudget(input: string, config: PublicConfig): BudgetCheck {
  if (config.policy.paymentsPaused)
    return { ok: false, message: 'Payments are paused. Resume them under Spending rules first.' };
  const tinybars = parseHbar(input);
  if (tinybars === null)
    return { ok: false, message: 'Enter an amount in HBAR, such as 0.003 (up to 8 decimals).' };
  if (tinybars <= 0n) return { ok: false, message: 'The budget must be more than zero.' };
  const max = BigInt(config.policy.maxPerRun);
  if (tinybars > max)
    return {
      ok: false,
      message: `The most a task may spend is ${hbar(max)} HBAR (the limit in force).`,
    };
  return { ok: true, tinybars };
}

/** The rules the firewall applies, as sentences. */
export function ruleSentences(config: PublicConfig, budget: bigint | null): string[] {
  const p = config.policy;
  const perTask = budget ?? BigInt(p.maxPerRun);
  const perPayment = BigInt(p.maxPerPayment) < perTask ? BigInt(p.maxPerPayment) : perTask;
  return [
    ...(p.paymentsPaused
      ? ['Payments are paused by the owner: nothing is paid until they are resumed.']
      : []),
    `This task may spend at most ${hbar(perTask)} HBAR in total.`,
    `No single payment may be more than ${hbar(perPayment)} HBAR.`,
    `All tasks together may spend at most ${hbar(p.maxPerDay)} HBAR per UTC day.`,
    `At most ${p.maxPaymentsPerRun} payments per task, and nothing is bought twice in one task.`,
    'Only providers found on ENS can be paid, at the price and to the payee their ENS records give.',
    p.allowedProviders === null
      ? 'Any provider discovered on ENS may be used.'
      : `Only these providers may be used: ${p.allowedProviders.join(', ')}.`,
    ...(p.blockedProviders.length === 0 ? [] : [`Never paid: ${p.blockedProviders.join(', ')}.`]),
    ...Object.entries(p.providerDailyCaps ?? {}).map(
      ([name, cap]) => `At most ${hbar(cap)} HBAR per UTC day to ${name}, across all tasks.`,
    ),
    p.approvalMode === 'human'
      ? BigInt(p.approvalAboveTinybars ?? '0') === 0n
        ? 'Human approval: every payment waits for the owner to approve it before it is signed.'
        : `Human approval: payments above ${hbar(p.approvalAboveTinybars ?? '0')} HBAR wait for the owner to approve them before they are signed.`
      : 'Autonomous: payments within these rules go ahead without asking the owner.',
    `The ENS reading must be at most ${Math.round(p.maxSnapshotAgeSec / 60)} minutes old when a payment is approved.`,
  ];
}

// ── the owner's policy editor (D-052) ─────────────────────────────────────

/** One per-provider daily cap row, as typed. */
export interface CapDraft {
  readonly name: string;
  readonly amount: string;
}

/** The editor's fields, as typed (HBAR text, a count, the switches, the cap rows). */
export interface PolicyDraft {
  readonly maxPerPayment: string;
  readonly maxPerRun: string;
  readonly maxPerDay: string;
  readonly maxPaymentsPerRun: string;
  readonly paymentsPaused: boolean;
  readonly approvalMode: ApprovalMode;
  readonly approvalAbove: string;
  readonly caps: readonly CapDraft[];
}

/** The server's limit on per-provider caps (policy-store MAX_PROVIDER_CAPS). */
export const MAX_PROVIDER_CAPS = 20;

const capsOf = (l: OwnerLimits): Readonly<Record<string, string>> => l.providerDailyCaps ?? {};

export const draftOf = (l: OwnerLimits): PolicyDraft => ({
  maxPerPayment: hbar(l.maxPerPayment),
  maxPerRun: hbar(l.maxPerRun),
  maxPerDay: hbar(l.maxPerDay),
  maxPaymentsPerRun: String(l.maxPaymentsPerRun),
  paymentsPaused: l.paymentsPaused,
  approvalMode: l.approvalMode ?? 'autonomous',
  approvalAbove: hbar(l.approvalAboveTinybars ?? '0'),
  caps: Object.entries(capsOf(l))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, amount]) => ({ name, amount: hbar(amount) })),
});

/** Has the person changed anything in the draft? Pure. */
export function draftDirty(d: PolicyDraft, initial: PolicyDraft): boolean {
  const text = [
    'maxPerPayment',
    'maxPerRun',
    'maxPerDay',
    'maxPaymentsPerRun',
    'approvalAbove',
  ] as const;
  if (text.some((k) => d[k].trim() !== initial[k])) return true;
  if (d.approvalMode !== initial.approvalMode) return true;
  const rows = (c: readonly CapDraft[]) =>
    JSON.stringify(c.map((r) => [r.name.trim().toLowerCase(), r.amount.trim()]));
  return rows(d.caps) !== rows(initial.caps);
}

export type DraftField = Exclude<keyof PolicyDraft, 'caps'> | `cap-${number}`;

export type DraftCheck =
  | { readonly ok: true; readonly limits: OwnerLimits }
  | { readonly ok: false; readonly errors: Partial<Record<DraftField, string>> };

const AMOUNT_FIELDS = ['maxPerPayment', 'maxPerRun', 'maxPerDay'] as const;
const FIELD_TEXT: Readonly<Record<(typeof AMOUNT_FIELDS)[number], string>> = {
  maxPerPayment: 'per payment',
  maxPerRun: 'per task',
  maxPerDay: 'per UTC day',
};

/**
 * Check a draft against the env ceiling, the way the server will. A
 * convenience for the form only: the server validates again and decides.
 */
export function checkDraft(d: PolicyDraft, ceiling: OwnerLimits): DraftCheck {
  const errors: Partial<Record<DraftField, string>> = {};
  const values: Partial<Record<(typeof AMOUNT_FIELDS)[number], bigint>> = {};
  for (const f of AMOUNT_FIELDS) {
    const v = parseHbar(d[f]);
    const max = BigInt(ceiling[f]);
    if (v === null) errors[f] = 'Enter an amount in HBAR, up to 8 decimals.';
    else if (v <= 0n) errors[f] = 'Must be more than zero.';
    else if (v > max) errors[f] = `The server allows at most ${hbar(max)} HBAR ${FIELD_TEXT[f]}.`;
    else values[f] = v;
  }
  const { maxPerPayment: pay, maxPerRun: run, maxPerDay: day } = values;
  if (pay !== undefined && run !== undefined && pay > run && errors.maxPerPayment === undefined)
    errors.maxPerPayment = 'Cannot be more than the per-task limit.';
  if (run !== undefined && day !== undefined && run > day && errors.maxPerRun === undefined)
    errors.maxPerRun = 'Cannot be more than the daily limit.';
  const count = /^\d{1,4}$/.test(d.maxPaymentsPerRun.trim()) ? Number(d.maxPaymentsPerRun) : NaN;
  if (!Number.isInteger(count) || count < 1)
    errors.maxPaymentsPerRun = 'A whole number, 1 or more.';
  else if (count > ceiling.maxPaymentsPerRun)
    errors.maxPaymentsPerRun = `The server allows at most ${ceiling.maxPaymentsPerRun}.`;
  const above = parseHbar(d.approvalAbove);
  if (above === null) errors.approvalAbove = 'Enter an amount in HBAR (0 = ask for every payment).';
  else if (above < 0n) errors.approvalAbove = 'Cannot be negative.';
  const caps: Record<string, string> = {};
  if (d.caps.length > MAX_PROVIDER_CAPS)
    errors['cap-0'] = `At most ${MAX_PROVIDER_CAPS} provider caps.`;
  d.caps.forEach((row, i) => {
    const key: DraftField = `cap-${i}`;
    const name = row.name.trim().toLowerCase();
    const v = parseHbar(row.amount);
    if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(name) || name.length > 255)
      errors[key] = 'Enter the provider’s ENS name, such as kev.example.eth.';
    else if (caps[name] !== undefined) errors[key] = 'This provider already has a cap.';
    else if (v === null) errors[key] = 'Enter an amount in HBAR, up to 8 decimals.';
    else if (v <= 0n) errors[key] = 'Must be more than zero (remove the row for no cap).';
    else if (day !== undefined && v > day) errors[key] = 'Cannot be more than the daily limit.';
    else caps[name] = v.toString();
  });
  if (
    Object.keys(errors).length > 0 ||
    pay === undefined ||
    run === undefined ||
    day === undefined ||
    above === null
  )
    return { ok: false, errors };
  return {
    ok: true,
    limits: {
      maxPerPayment: pay.toString(),
      maxPerRun: run.toString(),
      maxPerDay: day.toString(),
      maxPaymentsPerRun: count,
      paymentsPaused: d.paymentsPaused,
      approvalMode: d.approvalMode,
      approvalAboveTinybars: above.toString(),
      providerDailyCaps: caps,
    },
  };
}

/** Do two sets of limits enforce the same thing? Used to confirm a save by reading it back. Pure. */
export function sameLimits(a: OwnerLimits, b: OwnerLimits): boolean {
  const caps = (l: OwnerLimits) =>
    JSON.stringify(Object.entries(capsOf(l)).sort(([x], [y]) => x.localeCompare(y)));
  return (
    a.maxPerPayment === b.maxPerPayment &&
    a.maxPerRun === b.maxPerRun &&
    a.maxPerDay === b.maxPerDay &&
    a.maxPaymentsPerRun === b.maxPaymentsPerRun &&
    a.paymentsPaused === b.paymentsPaused &&
    (a.approvalMode ?? 'autonomous') === (b.approvalMode ?? 'autonomous') &&
    (a.approvalAboveTinybars ?? '0') === (b.approvalAboveTinybars ?? '0') &&
    caps(a) === caps(b)
  );
}

export interface PolicyChange {
  readonly field: keyof OwnerLimits;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  /** What it means for the agent, in a sentence. */
  readonly effect: string;
}

const money = (v: string) => `${hbar(v)} HBAR`;

/** What would change, and what each change does. Pure. */
export function policyChanges(current: OwnerLimits, next: OwnerLimits): PolicyChange[] {
  const out: PolicyChange[] = [];
  const amount = (field: (typeof AMOUNT_FIELDS)[number], label: string, what: string) => {
    if (current[field] === next[field]) return;
    const lower = BigInt(next[field]) < BigInt(current[field]);
    out.push({
      field,
      label,
      from: money(current[field]),
      to: money(next[field]),
      effect: `${lower ? 'Tighter' : 'Looser'}: ${what} ${money(next[field])}.${lower ? ' Applies to the next payment, including in a task that is already running.' : ' Applies from the next task.'}`,
    });
  };
  amount('maxPerPayment', 'Per payment', 'no single payment above');
  amount('maxPerRun', 'Per task', 'a task may spend at most');
  amount('maxPerDay', 'Per UTC day', 'all tasks together may spend at most');
  if (current.maxPaymentsPerRun !== next.maxPaymentsPerRun)
    out.push({
      field: 'maxPaymentsPerRun',
      label: 'Payments per task',
      from: String(current.maxPaymentsPerRun),
      to: String(next.maxPaymentsPerRun),
      effect: `At most ${next.maxPaymentsPerRun} payments in one task.`,
    });
  if (current.paymentsPaused !== next.paymentsPaused)
    out.push({
      field: 'paymentsPaused',
      label: 'Payments',
      from: current.paymentsPaused ? 'Paused' : 'Allowed',
      to: next.paymentsPaused ? 'Paused' : 'Allowed',
      effect: next.paymentsPaused
        ? 'The firewall refuses every payment from the moment this is saved, in running tasks too. New tasks cannot start.'
        : 'Payments are allowed again within the limits; new tasks can start.',
    });
  const mode = (l: OwnerLimits) => l.approvalMode ?? 'autonomous';
  const above = (l: OwnerLimits) => l.approvalAboveTinybars ?? '0';
  const asked = (l: OwnerLimits) =>
    BigInt(above(l)) === 0n ? 'every payment' : `payments above ${money(above(l))}`;
  if (mode(current) !== mode(next))
    out.push({
      field: 'approvalMode',
      label: 'Approval',
      from: mode(current) === 'human' ? 'Human approval' : 'Autonomous',
      to: mode(next) === 'human' ? 'Human approval' : 'Autonomous',
      effect:
        mode(next) === 'human'
          ? `${asked(next)[0]?.toUpperCase()}${asked(next).slice(1)} will wait for your approval on the task page before anything is signed. Unanswered requests expire and the payment is not made.`
          : 'Payments within the limits go ahead without asking you. Requests already waiting still need an answer or expire.',
    });
  else if (mode(next) === 'human' && above(current) !== above(next))
    out.push({
      field: 'approvalAboveTinybars',
      label: 'Ask for approval',
      from: asked(current),
      to: asked(next),
      effect: `From the next payment, ${asked(next)} will wait for your approval.`,
    });
  const before = capsOf(current);
  const after = capsOf(next);
  for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const was = before[name];
    const now = after[name];
    if (was === now) continue;
    out.push({
      field: 'providerDailyCaps',
      label: `Daily cap for ${name}`,
      from: was === undefined ? 'No cap' : money(was),
      to: now === undefined ? 'No cap' : money(now),
      effect:
        now === undefined
          ? `Only the overall daily limit applies to ${name}.`
          : `All tasks together may pay ${name} at most ${money(now)} per UTC day; a payment that would pass it is refused (OVER_PROVIDER_DAILY_BUDGET).`,
    });
  }
  return out;
}
