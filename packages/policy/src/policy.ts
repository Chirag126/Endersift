/**
 * The spending policy: configuration only (env or the owner's UI), never
 * model output. Amounts are atomic units of the policy asset (tinybars for
 * HBAR), as bigint.
 */
import { EnsName, HederaAccountId, Slug } from '@agent-economy/core/domain';

export const POLICY_NETWORKS = ['hedera:testnet', 'hedera:mainnet'] as const;
export type PolicyNetwork = (typeof POLICY_NETWORKS)[number];

export interface SpendingPolicy {
  readonly network: PolicyNetwork;
  /** 0.0.0 = HBAR, otherwise an HTS token ID. */
  readonly asset: string;
  /** The paying account (never a valid payee). */
  readonly payer: string;
  readonly maxPerPayment: bigint;
  readonly maxPerRun: bigint;
  readonly maxPerDay: bigint;
  readonly maxPaymentsPerRun: number;
  /** How old the ENS discovery snapshot may be when a purchase is authorised. */
  readonly maxSnapshotAgeMs: number;
  /** ENS names that may be bought from; null = any discovered, active provider. */
  readonly allowedProviders: readonly string[] | null;
  readonly blockedProviders: readonly string[];
  /** Capabilities that may be bought; null = any. */
  readonly allowedCapabilities: readonly string[] | null;
  /**
   * The owner's kill switch (D-052). When true, every purchase is refused with
   * PAYMENTS_PAUSED before any other rule. Absent = not paused.
   */
  readonly paymentsPaused?: boolean;
  /**
   * Per-provider daily caps (D-066): ENS name → the most that may be committed
   * to that provider in one UTC day, across runs. Absent or empty = no cap
   * beyond maxPerDay. Only the owner sets these; the model cannot.
   */
  readonly providerDailyCaps?: Readonly<Record<string, bigint>>;
}

export class PolicyError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid spending policy: ${problems.join('; ')}`);
    this.name = 'PolicyError';
    this.problems = problems;
  }
}

/** Every problem with a policy, or an empty list. */
export function policyProblems(p: SpendingPolicy): string[] {
  const out: string[] = [];
  if (!(POLICY_NETWORKS as readonly string[]).includes(p.network))
    out.push('network must be hedera:testnet or hedera:mainnet');
  if (!HederaAccountId.safeParse(p.asset).success) out.push('asset must be a Hedera entity ID');
  if (!HederaAccountId.safeParse(p.payer).success) out.push('payer must be a Hedera account ID');
  for (const [name, v] of [
    ['maxPerPayment', p.maxPerPayment],
    ['maxPerRun', p.maxPerRun],
    ['maxPerDay', p.maxPerDay],
  ] as const) {
    if (typeof v !== 'bigint' || v <= 0n) out.push(`${name} must be a positive bigint`);
  }
  if (
    typeof p.maxPerRun === 'bigint' &&
    typeof p.maxPerPayment === 'bigint' &&
    p.maxPerRun < p.maxPerPayment
  )
    out.push('maxPerRun must be >= maxPerPayment');
  if (
    typeof p.maxPerDay === 'bigint' &&
    typeof p.maxPerRun === 'bigint' &&
    p.maxPerDay < p.maxPerRun
  )
    out.push('maxPerDay must be >= maxPerRun');
  if (!Number.isInteger(p.maxPaymentsPerRun) || p.maxPaymentsPerRun < 1)
    out.push('maxPaymentsPerRun must be an integer >= 1');
  if (!Number.isInteger(p.maxSnapshotAgeMs) || p.maxSnapshotAgeMs < 1)
    out.push('maxSnapshotAgeMs must be a positive integer');
  for (const n of [...(p.allowedProviders ?? []), ...p.blockedProviders])
    if (!EnsName.safeParse(n).success)
      out.push(`provider list entry ${JSON.stringify(n)} is not an ENS name`);
  if (p.paymentsPaused !== undefined && typeof p.paymentsPaused !== 'boolean')
    out.push('paymentsPaused must be a boolean');
  if (p.providerDailyCaps !== undefined) {
    if (typeof p.providerDailyCaps !== 'object' || p.providerDailyCaps === null)
      out.push('providerDailyCaps must be an object of ENS name → bigint');
    else
      for (const [name, cap] of Object.entries(p.providerDailyCaps)) {
        if (!EnsName.safeParse(name).success)
          out.push(`providerDailyCaps key ${JSON.stringify(name)} is not an ENS name`);
        if (typeof cap !== 'bigint' || cap <= 0n)
          out.push(`providerDailyCaps[${JSON.stringify(name)}] must be a positive bigint`);
      }
  }
  for (const c of p.allowedCapabilities ?? [])
    if (!Slug.safeParse(c).success) out.push(`capability ${JSON.stringify(c)} is not a slug`);
  return out;
}

export function assertPolicy(p: SpendingPolicy): SpendingPolicy {
  const problems = policyProblems(p);
  if (problems.length > 0) throw new PolicyError(problems);
  return p;
}
