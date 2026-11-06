/**
 * Deterministic pre-signing guard for x402 payment requirements.
 *
 * The full spending firewall is `authorize()` in packages/policy (D-041): it
 * binds the quote to the provider's ENS records and applies run and daily
 * budgets. This guard stays as the second, independent layer inside the x402
 * client's `beforePaymentCreation` hook, so a quote that fails any rule is
 * refused BEFORE a transaction is built or signed. Nothing here can be
 * influenced by model output: the policy comes from configuration.
 */

const ENTITY_ID = /^0\.0\.\d+$/;
const ATOMIC_AMOUNT = /^\d{1,20}$/;

export interface PaymentGuardPolicy {
  /** CAIP-2 network payments must settle on, e.g. hedera:testnet. */
  readonly network: string;
  /** Asset that may be paid: 0.0.0 for HBAR or an HTS token ID. */
  readonly asset: string;
  /** Maximum amount per payment, in atomic units (tinybars for HBAR). */
  readonly maxAmount: bigint;
  /** Accounts that may be paid. Anything else is refused. */
  readonly allowedPayTo: readonly string[];
  /** The paying account; paying it would be a self-payment. */
  readonly payer: string;
}

/** The fields of an x402 v2 PaymentRequirements object the guard inspects. */
export interface GuardedRequirements {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount?: string;
  readonly payTo: string;
  readonly extra?: Record<string, unknown>;
}

export type GuardCode =
  | 'SCHEME_NOT_EXACT'
  | 'NETWORK_MISMATCH'
  | 'ASSET_MISMATCH'
  | 'AMOUNT_INVALID'
  | 'AMOUNT_OVER_CAP'
  | 'PAYTO_INVALID'
  | 'PAYTO_IS_PAYER'
  | 'PAYTO_NOT_ALLOWED'
  | 'FEE_PAYER_INVALID'
  | 'FEE_PAYER_IS_PARTY';

export type GuardDecision =
  | { readonly ok: true; readonly amount: bigint }
  | { readonly ok: false; readonly code: GuardCode; readonly reason: string };

const deny = (code: GuardCode, reason: string): GuardDecision => ({ ok: false, code, reason });

export function evaluatePaymentRequirements(
  req: GuardedRequirements,
  policy: PaymentGuardPolicy,
): GuardDecision {
  if (req.scheme !== 'exact')
    return deny('SCHEME_NOT_EXACT', `scheme "${req.scheme}" is not "exact"`);
  if (req.network !== policy.network) {
    return deny('NETWORK_MISMATCH', `network ${req.network} is not ${policy.network}`);
  }
  if (req.asset !== policy.asset) {
    return deny('ASSET_MISMATCH', `asset ${req.asset} is not the configured asset ${policy.asset}`);
  }

  if (req.amount === undefined || !ATOMIC_AMOUNT.test(req.amount)) {
    return deny('AMOUNT_INVALID', 'amount is missing or not a whole number of atomic units');
  }
  const amount = BigInt(req.amount);
  if (amount <= 0n) return deny('AMOUNT_INVALID', 'amount must be greater than zero');
  if (amount > policy.maxAmount) {
    return deny(
      'AMOUNT_OVER_CAP',
      `amount ${amount} exceeds the per-payment cap ${policy.maxAmount}`,
    );
  }

  if (!ENTITY_ID.test(req.payTo)) return deny('PAYTO_INVALID', 'payTo is not a Hedera account ID');
  if (req.payTo === policy.payer)
    return deny('PAYTO_IS_PAYER', 'payTo is the paying account itself');
  if (!policy.allowedPayTo.includes(req.payTo)) {
    return deny('PAYTO_NOT_ALLOWED', `payTo ${req.payTo} is not an allowed provider account`);
  }

  const feePayer = req.extra?.['feePayer'];
  if (typeof feePayer !== 'string' || !ENTITY_ID.test(feePayer)) {
    return deny('FEE_PAYER_INVALID', 'extra.feePayer is missing or not a Hedera account ID');
  }
  if (feePayer === req.payTo || feePayer === policy.payer) {
    return deny('FEE_PAYER_IS_PARTY', 'the facilitator fee payer must not be the payer or payee');
  }

  return { ok: true, amount };
}
