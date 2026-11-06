/**
 * The spending firewall (plan row 19): one pure, synchronous function that
 * decides whether ONE x402 purchase may be signed.
 *
 * Trust model:
 *   intent     UNTRUSTED. What the model (0G) asked to buy. Parsed with a
 *              strict schema: only provider, capability and a rationale. The
 *              rationale is never read by any rule, so "the budget was raised",
 *              "admin approved" or "ignore the cap" cannot change a decision,
 *              and extra fields (a payTo, a price, an override flag) make the
 *              request invalid instead of being honoured.
 *   quote      UNTRUSTED. The provider's 402 payment requirements. Must equal
 *              the ENS records exactly (price, payee, network, asset).
 *   providers  The ENS discovery snapshot (validated ProviderAgent records,
 *              written only by the parent owner for payout keys, D-033).
 *   policy     Configuration. state: the spend ledger (committed amounts
 *              already include in-flight and UNKNOWN payments).
 *
 * Same inputs, same decision: no clock reads (`now` is an input), no I/O,
 * no randomness. Every broken rule is reported; `code` is the first by
 * REASON_CODES priority.
 */
import { EnsName, Slug, type ProviderAgent } from '@agent-economy/core/domain';
import { z } from 'zod';
import { REASON_DESCRIPTIONS, codePriority, type ReasonCode } from './codes.ts';
import { policyProblems, type SpendingPolicy } from './policy.ts';

/** What the model may ask for. Nothing else: unknown keys are refused. */
export const PurchaseIntent = z
  .object({
    provider: EnsName,
    capability: Slug,
    rationale: z.string().min(1).max(400),
  })
  .strict();
export type PurchaseIntent = z.infer<typeof PurchaseIntent>;

/** The x402 v2 PaymentRequirements fields the firewall inspects, plus the resource URL. */
export interface X402Quote {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount?: string | undefined;
  readonly payTo: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  /** PaymentRequired.resource.url, when the server sent one. */
  readonly resourceUrl?: string | null;
}

export interface Purchase {
  readonly provider: string;
  readonly capability: string;
}

export interface SpendState {
  /** Settled + in flight + UNKNOWN payments of this run (atomic units). */
  readonly runCommitted: bigint;
  /** Same for the current UTC day, across runs. */
  readonly dayCommitted: bigint;
  /** Payments started this run (any status except REFUSED). */
  readonly runPayments: number;
  /** Provider + capability pairs already bought or in flight this run. */
  readonly runPurchases: readonly Purchase[];
  /**
   * Committed spend today per payee account (Hedera ID → atomic units), for the
   * per-provider caps (D-066). A payee not in the map spent nothing today; no map
   * at all means unknown, and a capped provider is then refused.
   */
  readonly dayCommittedByPayee?: Readonly<Record<string, bigint>>;
}

export interface AuthorizeInput {
  readonly intent: unknown;
  readonly quote: X402Quote;
  /** The URL the client requested and is about to pay for (client-side fact). */
  readonly requestUrl: string;
  readonly providers: readonly ProviderAgent[];
  readonly snapshot: { readonly blockNumber: bigint; readonly observedAt: string };
  readonly state: SpendState;
  readonly policy: SpendingPolicy;
  readonly now: string;
}

export interface Violation {
  readonly code: ReasonCode;
  readonly detail: string;
}

export type Decision =
  | {
      readonly allow: true;
      readonly amount: bigint;
      readonly provider: ProviderAgent;
      readonly intent: PurchaseIntent;
      /** Committed spend after this payment, for the ledger and the UI. */
      readonly runCommittedAfter: bigint;
      readonly dayCommittedAfter: bigint;
    }
  | {
      readonly allow: false;
      readonly code: ReasonCode;
      readonly reason: string;
      readonly violations: readonly Violation[];
    };

const ENTITY_ID = /^0\.0\.\d+$/;
const ATOMIC = /^[1-9]\d{0,29}$/;

function deny(violations: Violation[]): Decision {
  const sorted = [...violations].sort((a, b) => codePriority(a.code) - codePriority(b.code));
  const first = sorted[0];
  if (first === undefined) throw new Error('deny() needs at least one violation');
  return {
    allow: false,
    code: first.code,
    reason: `${REASON_DESCRIPTIONS[first.code]}: ${first.detail}`,
    violations: sorted,
  };
}

/** True when `url` is the endpoint itself or a path below it, on the same origin. */
export function isUnderEndpoint(url: string, endpoint: string): boolean {
  let u: URL;
  let e: URL;
  try {
    u = new URL(url);
    e = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.username !== '' || u.password !== '') return false;
  if (u.origin !== e.origin) return false;
  const base = e.pathname.replace(/\/+$/, '');
  return u.pathname === base || u.pathname.startsWith(`${base}/`);
}

export function authorize(input: AuthorizeInput): Decision {
  const { policy, quote, state } = input;

  const problems = policyProblems(policy);
  if (problems.length > 0)
    return deny(problems.map((detail) => ({ code: 'POLICY_INVALID', detail })));

  // the kill switch outranks everything else: no quote, intent or budget matters
  if (policy.paymentsPaused === true)
    return deny([{ code: 'PAYMENTS_PAUSED', detail: 'payments are paused by the owner' }]);

  const parsed = PurchaseIntent.safeParse(input.intent);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return deny([{ code: 'INTENT_INVALID', detail }]);
  }
  const intent = parsed.data;

  const age = Date.parse(input.now) - Date.parse(input.snapshot.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > policy.maxSnapshotAgeMs) {
    return deny([
      {
        code: 'SNAPSHOT_STALE',
        detail: `snapshot at block ${input.snapshot.blockNumber} observed ${input.snapshot.observedAt}, now ${input.now}`,
      },
    ]);
  }

  const provider = input.providers.find((p) => p.ensName === intent.provider);
  if (provider === undefined) {
    return deny([{ code: 'PROVIDER_UNKNOWN', detail: `${intent.provider} was not discovered` }]);
  }

  const v: Violation[] = [];
  const add = (code: ReasonCode, detail: string) => v.push({ code, detail });

  // provider and capability
  if (policy.blockedProviders.includes(provider.ensName)) add('PROVIDER_BLOCKED', provider.ensName);
  if (policy.allowedProviders !== null && !policy.allowedProviders.includes(provider.ensName))
    add('PROVIDER_NOT_ALLOWED', provider.ensName);
  if (!provider.capabilities.includes(intent.capability))
    add(
      'CAPABILITY_NOT_OFFERED',
      `${intent.capability} not in [${provider.capabilities.join(', ')}]`,
    );
  if (
    policy.allowedCapabilities !== null &&
    !policy.allowedCapabilities.includes(intent.capability)
  )
    add('CAPABILITY_NOT_ALLOWED', intent.capability);
  if (!isUnderEndpoint(input.requestUrl, provider.endpoint))
    add('ENDPOINT_MISMATCH', `${input.requestUrl} is not under ${provider.endpoint}`);
  if (
    quote.resourceUrl !== undefined &&
    quote.resourceUrl !== null &&
    !isUnderEndpoint(quote.resourceUrl, provider.endpoint)
  )
    add(
      'ENDPOINT_MISMATCH',
      `quoted resource ${quote.resourceUrl} is not under ${provider.endpoint}`,
    );

  // quote against ENS records and policy
  if (quote.scheme !== 'exact') add('SCHEME_NOT_EXACT', `scheme ${JSON.stringify(quote.scheme)}`);
  if (quote.network !== policy.network)
    add('NETWORK_MISMATCH', `quote network ${quote.network}, policy ${policy.network}`);
  if (provider.network !== policy.network)
    add('NETWORK_MISMATCH', `ENS x402.network ${provider.network}, policy ${policy.network}`);
  if (quote.asset !== policy.asset)
    add('ASSET_MISMATCH', `quote asset ${quote.asset}, policy ${policy.asset}`);
  if (provider.asset !== policy.asset)
    add('ASSET_MISMATCH', `ENS x402.asset ${provider.asset}, policy ${policy.asset}`);

  const amount =
    quote.amount !== undefined && ATOMIC.test(quote.amount) ? BigInt(quote.amount) : null;
  if (amount === null) add('AMOUNT_INVALID', `amount ${JSON.stringify(quote.amount ?? null)}`);
  else if (amount !== BigInt(provider.priceAtomic))
    add('PRICE_MISMATCH', `quote ${amount}, ENS agent.price ${provider.priceAtomic}`);

  if (!ENTITY_ID.test(quote.payTo)) add('PAYTO_INVALID', JSON.stringify(quote.payTo));
  else {
    if (quote.payTo !== provider.payTo)
      add('PAYTO_MISMATCH', `quote ${quote.payTo}, ENS x402.payTo ${provider.payTo}`);
    if (quote.payTo === policy.payer) add('PAYTO_IS_PAYER', quote.payTo);
  }
  const feePayer = quote.extra?.['feePayer'];
  if (typeof feePayer !== 'string' || !ENTITY_ID.test(feePayer))
    add('FEE_PAYER_INVALID', JSON.stringify(feePayer ?? null));
  else if (feePayer === quote.payTo || feePayer === policy.payer)
    add('FEE_PAYER_IS_PARTY', feePayer);

  // budgets and limits (the amount used is the ENS price when the quote is unusable,
  // so a budget violation is still reported alongside a malformed quote)
  const charge = amount ?? BigInt(provider.priceAtomic);
  if (
    state.runPurchases.some(
      (p) => p.provider === provider.ensName && p.capability === intent.capability,
    )
  )
    add('DUPLICATE_PURCHASE', `${provider.ensName} / ${intent.capability}`);
  if (state.runPayments >= policy.maxPaymentsPerRun)
    add('RUN_PAYMENT_LIMIT', `${state.runPayments} of ${policy.maxPaymentsPerRun} payments made`);
  if (charge > policy.maxPerPayment)
    add('OVER_PER_PAYMENT_CAP', `${charge} > ${policy.maxPerPayment}`);
  if (state.runCommitted + charge > policy.maxPerRun)
    add('OVER_RUN_BUDGET', `${state.runCommitted} + ${charge} > ${policy.maxPerRun}`);
  if (state.dayCommitted + charge > policy.maxPerDay)
    add('OVER_DAILY_BUDGET', `${state.dayCommitted} + ${charge} > ${policy.maxPerDay}`);
  const providerCap = policy.providerDailyCaps?.[provider.ensName];
  if (providerCap !== undefined) {
    const byPayee = state.dayCommittedByPayee;
    // a payee missing from a known map has no spend today; no map at all means unknown
    const spent = byPayee === undefined ? undefined : (byPayee[provider.payTo] ?? 0n);
    // fail closed: a capped provider is never paid when today's spend with it is not known
    if (spent === undefined)
      add('OVER_PROVIDER_DAILY_BUDGET', `today's spend with ${provider.ensName} is not known`);
    else if (spent + charge > providerCap)
      add(
        'OVER_PROVIDER_DAILY_BUDGET',
        `${spent} + ${charge} > ${providerCap} for ${provider.ensName}`,
      );
  }

  if (v.length > 0) return deny(v);
  return {
    allow: true,
    amount: charge,
    provider,
    intent,
    runCommittedAfter: state.runCommitted + charge,
    dayCommittedAfter: state.dayCommitted + charge,
  };
}
