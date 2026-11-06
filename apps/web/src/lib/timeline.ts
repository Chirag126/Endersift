/**
 * The run trail: each recorded run event (D-046) as a step a person can read,
 * with the proofs that back it (ENS block, Hedera transaction, 0G request).
 * Unknown event types still show, with their raw type, so nothing is hidden.
 * Pure.
 */
import { hbar, zgAmount } from './format.ts';
import type { RunEvent } from './types.ts';

export type Tone = 'neutral' | 'good' | 'warn' | 'bad';

export type Proof =
  | { readonly kind: 'ens-block'; readonly value: string }
  | { readonly kind: 'tx'; readonly value: string; readonly href: string | null }
  | { readonly kind: 'request'; readonly value: string }
  | { readonly kind: 'account'; readonly value: string };

export interface TrailStep {
  readonly seq: number;
  readonly at: string;
  readonly type: string;
  readonly tone: Tone;
  readonly title: string;
  readonly detail: string | null;
  readonly proofs: readonly Proof[];
}

/** What firewall and orchestrator codes mean, in plain words. */
export const CODE_TEXT: Readonly<Record<string, string>> = {
  OVER_RUN_BUDGET: "it would go over this task's budget",
  OVER_DAILY_BUDGET: "it would go over today's spending limit",
  OVER_PROVIDER_DAILY_BUDGET: "it would go over today's cap for this provider",
  APPROVAL_REJECTED: 'the owner rejected this payment; it was never signed',
  APPROVAL_EXPIRED: 'nobody approved this payment in time; it was never signed',
  APPROVAL_QUOTE_CHANGED: 'the provider changed its quote after approval; nothing was signed',
  APPROVAL_UNAVAILABLE: 'it needed approval, which could not be asked; it was never signed',
  REQUOTE_FAILED: 'the provider could not be asked for its quote again after approval',
  SELF_PROVIDER: "it is this agent's own listing; the agent does not buy from itself",
  PAYMENTS_PAUSED: 'the owner has paused all payments',
  SPEND_UNVERIFIED:
    "today's spending could not be checked on the Hedera Mirror Node, so nothing was spent",
  INVALID_BUDGET: 'its budget is above the per-task limit in force',
  QUEUE_FULL: 'other tasks were already waiting',
  ALREADY_CLAIMED: 'another server process already started it',
  DUPLICATE_SCHEDULED_RUN: 'another server process already started this day’s brief',
  OVER_PAYMENT_CAP: 'it costs more than the per-payment limit',
  OVER_PER_PAYMENT_CAP: 'it costs more than the per-payment limit',
  RUN_PAYMENT_LIMIT: 'this task already made the most payments allowed',
  TOO_MANY_PAYMENTS: 'this task already made the most payments allowed',
  DUPLICATE_PURCHASE: 'the same thing was already bought in this task',
  PAYTO_MISMATCH: 'the payee differs from the one on ENS',
  PRICE_MISMATCH: 'the price differs from the one on ENS',
  PROVIDER_UNKNOWN: 'the provider was not found on ENS',
  UNGROUNDED_IDS: 'the plan named advisory IDs that are not in your watchlist',
  UNKNOWN_PROVIDER: 'the plan named a provider that is not on ENS',
  UNKNOWN_OPERATION: 'the provider does not offer that operation',
  UNKNOWN_CAPABILITY: 'the provider does not publish that capability',
  PARAM_NOT_ALLOWED: 'the plan used a parameter the provider does not accept',
  PROVIDER_UNAVAILABLE: "the provider's catalog could not be used",
  PLAN_LIMIT: 'the plan asked for more purchases than one task may make',
  NOT_SETTLED: 'the payment is not verified as settled, so its data is not used',
  SCHEMA_INVALID: 'the data did not have the expected shape',
  PROVIDER_MISMATCH: 'the data came back under another provider name',
  CATALOG_MISMATCH: "the provider's catalog disagrees with its ENS records",
  CATALOG_INVALID: "the provider's catalog is malformed",
  CATALOG_UNREACHABLE: "the provider's catalog could not be reached",
  NO_DATA: 'no purchase delivered usable data',
  NO_PROVIDERS: 'no usable provider was found on ENS',
  NO_CATALOG: 'no provider offered a catalog that matches ENS',
  DISCOVERY_FAILED: 'ENS could not be read',
  PLAN_FAILED: '0G could not produce a usable plan',
  ANALYSIS_FAILED: '0G could not produce a usable analysis',
  ANALYSIS_INVALID: 'the analysis named advisories it was not given',
  INVENTED_IDS: 'the analysis named advisories it was not given',
  DAILY_CAP_EXCEEDED: "0G's daily spending cap would be exceeded",
  NO_BILLING_TRACE:
    '0G returned the text without a request ID or bill; held at its reserved worst case until reconciled',
  COST_OVER_CAP: 'the 0G call would cost more than the per-call cap',
  INTERRUPTED: 'the server stopped during the task',
  ADDRESS_BLOCKED: 'its address is not a public internet address',
  REDIRECT_REFUSED: 'it tried to redirect the request elsewhere',
  SCHEME_NOT_ALLOWED: 'it is not served over https',
  RESPONSE_TOO_LARGE: 'it answered with too much data',
  TIMEOUT: 'it did not answer in time',
  INTERNAL: 'an internal error stopped the task',
};

/** "OVER_RUN_BUDGET" → "it would go over this task's budget"; unknown codes stay readable. */
export function explainCode(code: unknown): string {
  if (typeof code !== 'string' || code === '') return 'no reason was given';
  const base = code.replace(/^(NET|OUTPUT|ROUTER)_/, '');
  return CODE_TEXT[code] ?? CODE_TEXT[base] ?? base.toLowerCase().replace(/_/g, ' ');
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const shortName = (ens: unknown): string => str(ens)?.split('.')[0] ?? 'a provider';

/** "Since the previous brief: 1 new, 0 gone, 2 priority changes" from REPORT_WRITTEN.delta. Pure. */
export function deltaText(delta: unknown): string | null {
  if (typeof delta !== 'object' || delta === null) return null;
  const d = delta as Record<string, unknown>;
  const n = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]).length : 0);
  const changed = n('changed');
  return `Since the previous brief: ${n('added')} new, ${n('gone')} no longer in the data, ${changed} priority change${changed === 1 ? '' : 's'}.`;
}

export function stepOf(e: RunEvent): TrailStep {
  const p = e.payload;
  const base = { seq: e.seq, at: e.at, type: e.type };
  const step = (tone: Tone, title: string, detail: string | null = null, proofs: Proof[] = []) => ({
    ...base,
    tone,
    title,
    detail,
    proofs,
  });
  switch (e.type) {
    case 'RUN_STARTED': {
      const policy = p['policy'] as Record<string, unknown> | undefined;
      const budget = str(policy?.['maxPerRun']);
      const watchlist = Array.isArray(p['watchlist']) ? p['watchlist'].join(', ') : null;
      return step(
        'neutral',
        'Task started',
        [
          watchlist === null ? null : `Watching ${watchlist}.`,
          budget === null ? null : `Budget ${hbar(budget)} HBAR.`,
        ]
          .filter((x) => x !== null)
          .join(' ') || null,
      );
    }
    case 'PROVIDERS_DISCOVERED': {
      const list = Array.isArray(p['providers']) ? p['providers'] : [];
      const block = str(p['blockNumber']);
      const skipped = (Array.isArray(p['skipped']) ? p['skipped'] : []) as Record<
        string,
        unknown
      >[];
      const why = skipped
        .map(
          (k) => `${str(k['label']) ?? '?'} skipped: ${str(k['reason']) ?? str(k['code']) ?? ''}`,
        )
        .join('; ');
      return step(
        list.length === 0 ? 'bad' : 'good',
        `Found ${list.length} provider${list.length === 1 ? '' : 's'} on ENS`,
        [
          `Registered under ${str(p['parent']) ?? 'the parent name'}.`,
          why === '' ? null : `${why}.`,
        ]
          .filter((x) => x !== null)
          .join(' '),
        block === null ? [] : [{ kind: 'ens-block', value: block }],
      );
    }
    case 'CATALOG_READ':
      return p['ok'] === true
        ? step(
            'neutral',
            `${shortName(p['provider'])} listed what it sells`,
            'Prices and payee match its ENS records',
          )
        : step('warn', `${shortName(p['provider'])} skipped`, explainCode(p['code']));
    case 'INFERENCE_CALLED': {
      const plan = p['purpose'] === 'PLAN';
      const ok = p['status'] === 'SUCCEEDED';
      const cost = str(p['costNeuron']);
      const request = str(p['requestId']);
      return step(
        ok ? 'neutral' : 'bad',
        ok
          ? plan
            ? '0G planned the purchases'
            : '0G analysed the data'
          : `0G ${plan ? 'plan' : 'analysis'} ${String(p['status']).toLowerCase()}`,
        [
          cost === null ? null : zgAmount(cost),
          p['teeVerified'] === true ? 'TEE signature verified' : null,
          ok ? null : explainCode(p['errorCode']),
        ]
          .filter((x) => x !== null)
          .join(', ') || null,
        request === null ? [] : [{ kind: 'request', value: request }],
      );
    }
    case 'PLAN_CREATED': {
      const n = Array.isArray(p['purchases']) ? p['purchases'].length : 0;
      return step(
        'neutral',
        n === 0 ? 'Nothing to buy' : `Plan: ${n} purchase${n === 1 ? '' : 's'}`,
        str(p['focus']),
      );
    }
    case 'PURCHASE_SKIPPED':
      return step('warn', `Not bought from ${shortName(p['provider'])}`, explainCode(p['code']));
    case 'PAYMENT_REFUSED':
      return step('bad', `Firewall refused ${shortName(p['provider'])}`, explainCode(p['code']));
    case 'PAYMENT_AUTHORIZED': {
      const amount = str(p['amountAtomic']);
      const payTo = str(p['payTo']);
      return step(
        'neutral',
        `Firewall approved ${amount === null ? 'a payment' : `${hbar(amount)} HBAR`} to ${shortName(p['provider'])}`,
        null,
        payTo === null ? [] : [{ kind: 'account', value: payTo }],
      );
    }
    case 'PAYMENT_APPROVAL_REQUESTED': {
      const amount = str(p['amountAtomic']);
      const until = str(p['expiresAt']);
      const payTo = str(p['payTo']);
      return step(
        'warn',
        `Waiting for your approval: ${amount === null ? 'a payment' : `${hbar(amount)} HBAR`} to ${shortName(p['provider'])}`,
        [
          'The firewall allowed it; nothing is signed until you answer.',
          until === null ? null : `Expires ${until.slice(11, 16)} UTC if not answered.`,
        ]
          .filter((x) => x !== null)
          .join(' '),
        payTo === null ? [] : [{ kind: 'account', value: payTo }],
      );
    }
    case 'PAYMENT_APPROVAL_DECIDED': {
      const decision = str(p['decision']);
      const by = str(p['decidedBy']);
      const note = str(p['note']);
      if (decision === 'APPROVED')
        return step(
          'good',
          'You approved the payment',
          'The quote is checked again before signing.' + (note === null ? '' : ` Note: ${note}`),
        );
      if (decision === 'REJECTED')
        return step(
          'warn',
          'You rejected the payment',
          'Nothing was signed.' + (note === null ? '' : ` Note: ${note}`),
        );
      return step(
        'warn',
        'Approval request expired',
        by === 'restart'
          ? 'The server restarted while it waited. Nothing was signed.'
          : 'Nobody answered in time. Nothing was signed.',
      );
    }
    case 'PAYMENT_SETTLED': {
      const tx = str(p['transactionId']);
      return step(
        'good',
        'Payment settled and verified on Hedera',
        'Checked on the Mirror Node before the data was used',
        tx === null ? [] : [{ kind: 'tx', value: tx, href: str(p['hashscan']) }],
      );
    }
    case 'PAYMENT_UNKNOWN': {
      const tx = str(p['transactionId']);
      return step(
        'warn',
        'Payment outcome not known yet',
        'It is never paid twice; the Mirror Node will settle the question later',
        tx === null ? [] : [{ kind: 'tx', value: tx, href: null }],
      );
    }
    case 'PAYMENT_FAILED':
      return step('bad', 'Payment failed', explainCode(p['errorCode']));
    case 'DATA_FETCHED': {
      const count = num(p['count']) ?? 0;
      return step(
        'good',
        `Received ${count} advisor${count === 1 ? 'y' : 'ies'} from ${shortName(p['provider'])}`,
        str(p['source']),
      );
    }
    case 'DATA_REJECTED':
      return step('warn', 'Data not used', explainCode(p['code']));
    case 'ANALYSIS_COMPLETED': {
      if (p['accepted'] !== true) return step('bad', 'Analysis rejected', explainCode(p['code']));
      // nothing to analyse: 0G was not called (D-083)
      if (p['items'] === 0 && p['assessments'] === undefined)
        return step(
          'warn',
          'No advisories to analyse',
          'The paid data had none, so 0G was not called',
        );
      const n = num(p['assessments']);
      const p1 = Array.isArray(p['p1']) ? p['p1'].length : 0;
      return step(
        'good',
        n === 0
          ? 'Analysis: nothing affects the watchlist'
          : `Analysis accepted: ${n ?? 0} assessed`,
        p1 > 0 ? `${p1} to act on today` : null,
      );
    }
    case 'REPORT_WRITTEN':
      return step('neutral', 'Brief written', deltaText(p['delta']));
    case 'RUN_FINISHED': {
      const pay = p['payments'] as Record<string, unknown> | undefined;
      const settled = str(pay?.['settledAtomic']);
      return step(
        'good',
        'Task finished',
        settled === null ? null : `${hbar(settled)} HBAR settled`,
      );
    }
    case 'RUN_FAILED':
      return step(
        'bad',
        'Task stopped',
        `${explainCode(p['code'])}${str(p['message']) ? ` (${String(p['message'])})` : ''}`,
      );
    default:
      return step('neutral', e.type.toLowerCase().replace(/_/g, ' '));
  }
}

/** Merge newly received events into a trail: by sequence number, no duplicates, in order. */
export function mergeEvents(
  current: readonly RunEvent[],
  incoming: readonly RunEvent[],
): RunEvent[] {
  const bySeq = new Map<number, RunEvent>();
  for (const e of current) bySeq.set(e.seq, e);
  for (const e of incoming) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The run ends with these events. */
export const isTerminalEvent = (type: string): boolean =>
  type === 'RUN_FINISHED' || type === 'RUN_FAILED';
