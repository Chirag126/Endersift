/**
 * The autonomous x402 buyer (plan row 21, D-043). One purchase, no human in
 * the loop, in this order:
 *
 *   1. request     GET the URL unpaid; a 402 carries the payment requirements
 *   2. open        one payment intent per purchase (idempotent, D-042); a
 *                  purchase already SETTLED / UNKNOWN / in flight is returned
 *                  as is and is NEVER paid again
 *   3. firewall    authorize() on the model's request, THIS quote, the ENS
 *                  snapshot and the persisted spend (D-041) → AUTHORIZED or REFUSED
 *   4. sign        exactly the authorised requirement (the signer refuses any
 *                  other in its own pre-signing hook)
 *   5. persist     the transaction ID (SIGNED), then SUBMITTED, both BEFORE
 *                  the paid request leaves the process
 *   6. send        the same URL with the payment header
 *   7. verify      the settlement verifier (Mirror Node only, D-044) decides:
 *                  SETTLED, FAILED, or UNKNOWN when it cannot tell in time
 *                  (never retried, reconciled later)
 *
 * Human approval mode (D-066) adds one step between 3 and 4: an AUTHORIZED
 * payment above the owner's threshold waits for the owner. Nothing is signed
 * before a yes. After a yes the kill switch is read again and the 402 is
 * fetched again: the payment is signed only if the quote is still exactly the
 * one approved. A no, a timeout or a changed quote ends it FAILED, unsigned.
 *
 * x402 specifics live behind the `PaymentSigner` interface (the Hedera
 * implementation is in packages/hedera/src/x402.ts), so this module and its
 * tests do not load the x402 or Hiero SDK packages.
 */
import type { PaymentIntent, ProviderAgent } from '@agent-economy/core/domain';
import type { MirrorTransaction } from '@agent-economy/hedera';
import {
  PurchaseIntent,
  authorize,
  type Decision,
  type SpendingPolicy,
  type X402Quote,
} from '@agent-economy/policy';
import { NetGuardError, createGuardedFetch } from '@agent-economy/net-guard';
import { utcDay, utcDayBounds } from '@agent-economy/zg';
import type { SettlementVerification } from './payment-store.ts';
import type { SettlementVerifier } from './settlement-verifier.ts';
import type { PaymentStateMachine } from './state-machine.ts';

/** The fields of an x402 v2 PaymentRequirements the buyer and the firewall use. */
export interface Requirement {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds?: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface PaymentRequiredInfo {
  readonly x402Version: number;
  readonly resourceUrl: string | null;
  readonly accepts: readonly Requirement[];
  /** The decoded object, passed back to the signer untouched. */
  readonly raw: unknown;
}

export interface SettleInfo {
  readonly success: boolean;
  readonly transaction: string | null;
  readonly errorReason: string | null;
}

export interface PaymentSigner {
  /** The paying account (public). */
  readonly payer: string;
  /** Decode the 402 response; throws if it is not a valid x402 payment-required response. */
  parsePaymentRequired(
    getHeader: (name: string) => string | null,
    body: unknown,
  ): PaymentRequiredInfo;
  /**
   * Sign a payment for exactly `requirement` (one of `required.accepts`).
   * Must refuse, before signing, if the requirement it would sign differs.
   */
  sign(
    required: PaymentRequiredInfo,
    requirement: Requirement,
  ): Promise<{
    readonly transactionId: string;
    readonly headers: Readonly<Record<string, string>>;
  }>;
  /** The facilitator's settle response from the paid response headers, or null. */
  parseSettle(getHeader: (name: string) => string | null): SettleInfo | null;
}

/**
 * The fetch the buyer must use outside tests (D-045): the URL comes from ENS
 * records and 402 responses, so it goes through the net-guard (https only,
 * every resolved address public, connection pinned, no redirects, 2 MiB and
 * 30 s caps). `allowLoopbackHttp` is for the local provider service only.
 */
export function buyerFetch(options: {
  readonly allowLoopbackHttp: boolean;
}): typeof globalThis.fetch {
  return createGuardedFetch({
    allowLoopbackHttp: options.allowLoopbackHttp,
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 30_000,
  });
}

export interface BuyerDeps {
  /** `buyerFetch(...)` in production; a fake in tests. */
  readonly fetch: typeof globalThis.fetch;
  readonly signer: PaymentSigner;
  readonly machine: PaymentStateMachine;
  /** Decides SETTLED / FAILED / UNKNOWN from the Mirror Node (D-044). */
  readonly verifier: Pick<SettlementVerifier, 'awaitSettlement'>;
  readonly now?: () => Date;
  /** Facilitator base URL recorded on the intent (the one the provider's quote names). */
  readonly facilitatorUrl: string;
}

/** The owner's decision on one payment (D-066). */
export interface ApprovalAnswer {
  readonly decision: 'APPROVED' | 'REJECTED' | 'EXPIRED';
  readonly approvalId: string;
}

/** Human approval mode for one purchase (D-066); absent = autonomous. */
export interface ApprovalGate {
  /** True when a payment of this amount must wait for the owner. */
  readonly needed: (amount: bigint) => boolean;
  /** Record the request and wait for the owner's answer or the timeout. */
  readonly ask: (request: {
    readonly intent: PaymentIntent;
    readonly amount: bigint;
  }) => Promise<ApprovalAnswer>;
  /** The policy in force after the wait: a pause saved meanwhile wins. */
  readonly policyNow: () => SpendingPolicy;
}

export interface BuyInput {
  readonly runId: string;
  /** The model's purchase request: UNTRUSTED, parsed by the firewall. */
  readonly intent: unknown;
  readonly url: string;
  readonly providers: readonly ProviderAgent[];
  readonly snapshot: { readonly blockNumber: bigint; readonly observedAt: string };
  readonly policy: SpendingPolicy;
  readonly requestTimeoutMs?: number;
  /** Human approval mode (D-066); absent = the agent pays on its own. */
  readonly approval?: ApprovalGate;
}

export type BuyOutcome =
  /** The URL answered without asking for payment. */
  | { readonly kind: 'free'; readonly status: number; readonly body: unknown }
  /** Refused before an intent could be opened (bad request, unknown provider, bad 402). */
  | { readonly kind: 'rejected'; readonly code: string; readonly reason: string }
  /** The purchase already exists in this run: returned, never paid again. */
  | { readonly kind: 'existing'; readonly intent: PaymentIntent }
  | { readonly kind: 'refused'; readonly intent: PaymentIntent; readonly decision: Decision }
  /**
   * Allowed by the firewall but not paid in Human approval mode (D-066): the
   * owner said no, did not answer in time, paused payments meanwhile, or the
   * quote changed. Never signed; the intent is FAILED with `code`.
   */
  | {
      readonly kind: 'not-approved';
      readonly intent: PaymentIntent;
      readonly decision: Decision;
      readonly approval: ApprovalAnswer | null;
      readonly code: string;
    }
  | {
      readonly kind: 'paid';
      readonly intent: PaymentIntent;
      readonly decision: Decision;
      readonly status: number | null;
      readonly body: unknown;
      readonly settle: SettleInfo | null;
      readonly mirror: readonly MirrorTransaction[];
      readonly verifications: readonly SettlementVerification[];
    };

const readBody = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
};

const header = (res: Response) => (name: string) => res.headers.get(name);

/** x402 amounts are integer strings; compare requirements field by field. */
export function sameRequirement(a: Requirement, b: Requirement): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset === b.asset &&
    a.amount === b.amount &&
    a.payTo === b.payTo &&
    a.extra?.['feePayer'] === b.extra?.['feePayer']
  );
}

export async function buyWithFirewall(deps: BuyerDeps, input: BuyInput): Promise<BuyOutcome> {
  const now = () => (deps.now ?? (() => new Date()))();
  const timeout = input.requestTimeoutMs ?? 30_000;

  // 1. unpaid request
  let first: Response;
  try {
    first = await deps.fetch(input.url, { signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    // e.g. the net-guard refusing a private address, http, a redirect or an oversize answer
    return {
      kind: 'rejected',
      code: error instanceof NetGuardError ? `NET_${error.code}` : 'REQUEST_FAILED',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (first.status !== 402)
    return { kind: 'free', status: first.status, body: await readBody(first) };
  let required: PaymentRequiredInfo;
  try {
    required = deps.signer.parsePaymentRequired(header(first), await readBody(first));
  } catch (error) {
    return {
      kind: 'rejected',
      code: 'PAYMENT_REQUIRED_INVALID',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  let requirement = required.accepts.find(
    (r) => r.scheme === 'exact' && r.network === input.policy.network,
  );
  if (requirement === undefined)
    return {
      kind: 'rejected',
      code: 'NO_ACCEPTABLE_REQUIREMENT',
      reason: `no exact requirement on ${input.policy.network} among ${required.accepts.length}`,
    };

  // 2. open the intent (needs a well-formed request naming a discovered provider)
  const parsed = PurchaseIntent.safeParse(input.intent);
  const provider = parsed.success
    ? input.providers.find((p) => p.ensName === parsed.data.provider)
    : undefined;
  if (!parsed.success || provider === undefined) {
    // Same codes as the firewall would give; nothing to persist without a provider record.
    const d = authorize({
      intent: input.intent,
      quote: toQuote(requirement, required.resourceUrl),
      requestUrl: input.url,
      providers: input.providers,
      snapshot: input.snapshot,
      state: { runCommitted: 0n, dayCommitted: 0n, runPayments: 0, runPurchases: [] },
      policy: input.policy,
      now: now().toISOString(),
    });
    return d.allow
      ? { kind: 'rejected', code: 'INTENT_INVALID', reason: 'request could not be resolved' }
      : { kind: 'rejected', code: d.code, reason: d.reason };
  }
  const { intent, created } = await deps.machine.open({
    runId: input.runId,
    provider,
    capability: parsed.data.capability,
    requestUrl: input.url,
  });
  if (!created && intent.status !== 'CREATED') return { kind: 'existing', intent };

  // 3. firewall on this exact quote and the persisted spend
  const day = utcDayBounds(utcDay(now().toISOString()));
  const state = await deps.machine.spendState(input.runId, day.start, day.end);
  const decision = authorize({
    intent: input.intent,
    quote: toQuote(requirement, required.resourceUrl),
    requestUrl: input.url,
    providers: input.providers,
    snapshot: input.snapshot,
    // the intent being decided is CREATED, so it is not in `state` yet
    state,
    policy: input.policy,
    now: now().toISOString(),
  });
  const decided = await deps.machine.decide(intent.id, decision);
  if (decided.status !== 'AUTHORIZED') return { kind: 'refused', intent: decided, decision };

  // 3b. Human approval mode (D-066): wait for the owner; nothing is signed before a yes
  if (input.approval !== undefined && decision.allow && input.approval.needed(decision.amount)) {
    let answer: ApprovalAnswer | null = null;
    const stop = async (code: string): Promise<BuyOutcome> => ({
      kind: 'not-approved',
      intent: await deps.machine.recordFailedBeforeSubmit(intent.id, code),
      decision,
      approval: answer,
      code,
    });
    try {
      answer = await input.approval.ask({ intent: decided, amount: decision.amount });
    } catch {
      return stop('APPROVAL_UNAVAILABLE');
    }
    if (answer.decision === 'REJECTED') return stop('APPROVAL_REJECTED');
    if (answer.decision !== 'APPROVED') return stop('APPROVAL_EXPIRED');
    if (input.approval.policyNow().paymentsPaused === true) return stop('PAYMENTS_PAUSED');
    // the approved payment must still be exactly the one on offer: fetch the quote again
    let again: Response;
    try {
      again = await deps.fetch(input.url, { signal: AbortSignal.timeout(timeout) });
    } catch {
      return stop('REQUOTE_FAILED');
    }
    if (again.status !== 402) return stop('REQUOTE_FAILED');
    let fresh: PaymentRequiredInfo;
    try {
      fresh = deps.signer.parsePaymentRequired(header(again), await readBody(again));
    } catch {
      return stop('REQUOTE_FAILED');
    }
    const approved = requirement;
    const same = fresh.accepts.find((r) => sameRequirement(r, approved));
    if (same === undefined) return stop('APPROVAL_QUOTE_CHANGED');
    required = fresh;
    requirement = same;
  }

  // 4–5. sign exactly this requirement; persist the tx ID and SUBMITTED before sending
  let signed: { transactionId: string; headers: Readonly<Record<string, string>> };
  try {
    signed = await deps.signer.sign(required, requirement);
  } catch (error) {
    const failed = await deps.machine.recordFailedBeforeSubmit(intent.id, 'SIGNING_FAILED');
    return {
      kind: 'paid',
      intent: failed,
      decision,
      status: null,
      body: { error: error instanceof Error ? error.message : String(error) },
      settle: null,
      mirror: [],
      verifications: [],
    };
  }
  await deps.machine.recordSigned(intent.id, signed.transactionId, deps.facilitatorUrl);
  await deps.machine.recordSubmitted(intent.id);

  // 6. send
  let status: number | null = null;
  let body: unknown = null;
  let settle: SettleInfo | null = null;
  try {
    const paid = await deps.fetch(input.url, {
      headers: { ...signed.headers },
      signal: AbortSignal.timeout(timeout),
    });
    status = paid.status;
    settle = deps.signer.parseSettle(header(paid));
    body = await readBody(paid);
  } catch (error) {
    body = { error: error instanceof Error ? error.message : String(error) };
  }

  // 7. the settlement verifier decides, from the Mirror Node only
  const v = await deps.verifier.awaitSettlement(intent.id);
  return {
    kind: 'paid',
    intent: v.intent,
    decision,
    status,
    body,
    settle,
    mirror: v.entries,
    verifications: v.verifications,
  };
}

function toQuote(r: Requirement, resourceUrl: string | null): X402Quote {
  return {
    scheme: r.scheme,
    network: r.network,
    asset: r.asset,
    amount: r.amount,
    payTo: r.payTo,
    ...(r.extra === undefined ? {} : { extra: r.extra }),
    resourceUrl,
  };
}
