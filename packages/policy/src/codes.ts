/**
 * Firewall reason codes, in priority order: when a purchase breaks several
 * rules, the decision's `code` is the first one listed here (all of them are
 * still returned as `violations`). Codes are stable identifiers: they are
 * persisted as `payment_intents.refusal_code` and shown in the UI.
 */
export const REASON_CODES = [
  // the policy itself
  'POLICY_INVALID',
  // the owner's kill switch (D-052): nothing is signed while payments are paused
  'PAYMENTS_PAUSED',
  // the model's request (untrusted)
  'INTENT_INVALID',
  // the provider, from the ENS discovery snapshot
  'SNAPSHOT_STALE',
  'PROVIDER_UNKNOWN',
  'PROVIDER_BLOCKED',
  'PROVIDER_NOT_ALLOWED',
  'CAPABILITY_NOT_OFFERED',
  'CAPABILITY_NOT_ALLOWED',
  'ENDPOINT_MISMATCH',
  // the 402 quote against the ENS records and the policy
  'SCHEME_NOT_EXACT',
  'NETWORK_MISMATCH',
  'ASSET_MISMATCH',
  'AMOUNT_INVALID',
  'PRICE_MISMATCH',
  'PAYTO_INVALID',
  'PAYTO_MISMATCH',
  'PAYTO_IS_PAYER',
  'FEE_PAYER_INVALID',
  'FEE_PAYER_IS_PARTY',
  // budgets and limits, against the spend ledger
  'DUPLICATE_PURCHASE',
  'RUN_PAYMENT_LIMIT',
  'OVER_PER_PAYMENT_CAP',
  'OVER_RUN_BUDGET',
  'OVER_DAILY_BUDGET',
  // the owner's per-provider daily cap (D-066)
  'OVER_PROVIDER_DAILY_BUDGET',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_DESCRIPTIONS: Readonly<Record<ReasonCode, string>> = {
  POLICY_INVALID: 'the spending policy is malformed; nothing can be authorised',
  PAYMENTS_PAUSED: 'the owner has paused all payments (kill switch); nothing is signed',
  INTENT_INVALID: 'the purchase request does not match the strict request schema',
  SNAPSHOT_STALE: 'the ENS discovery snapshot is older than the policy allows',
  PROVIDER_UNKNOWN: 'the provider is not in the ENS discovery snapshot',
  PROVIDER_BLOCKED: 'the provider is on the policy block list',
  PROVIDER_NOT_ALLOWED: 'the policy allow list does not include the provider',
  CAPABILITY_NOT_OFFERED: "the capability is not in the provider's ENS agent.capabilities",
  CAPABILITY_NOT_ALLOWED: 'the policy does not allow buying this capability',
  ENDPOINT_MISMATCH: "the URL being paid for is not under the provider's ENS agent.endpoint",
  SCHEME_NOT_EXACT: 'the quote is not the x402 exact scheme',
  NETWORK_MISMATCH: 'the quote or the ENS x402.network is not the policy network',
  ASSET_MISMATCH: 'the quote or the ENS x402.asset is not the policy asset',
  AMOUNT_INVALID: 'the quoted amount is missing, malformed or zero',
  PRICE_MISMATCH: 'the quoted amount differs from the ENS agent.price',
  PAYTO_INVALID: 'the quoted payee is not a Hedera account ID',
  PAYTO_MISMATCH: 'the quoted payee differs from the ENS x402.payTo',
  PAYTO_IS_PAYER: 'the quoted payee is the paying account',
  FEE_PAYER_INVALID: 'the facilitator fee payer is missing or malformed',
  FEE_PAYER_IS_PARTY: 'the facilitator fee payer is the payer or the payee',
  DUPLICATE_PURCHASE:
    'this provider and capability were already bought (or are in flight) this run',
  RUN_PAYMENT_LIMIT: 'the run has reached its maximum number of payments',
  OVER_PER_PAYMENT_CAP: 'the amount exceeds the per-payment cap',
  OVER_RUN_BUDGET: 'committed spend this run plus the amount exceeds the run budget',
  OVER_DAILY_BUDGET: 'committed spend today plus the amount exceeds the daily budget',
  OVER_PROVIDER_DAILY_BUDGET:
    "committed spend today with this provider plus the amount exceeds the owner's cap for it",
};

export const codePriority = (code: ReasonCode): number => REASON_CODES.indexOf(code);
