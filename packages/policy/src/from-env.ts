/**
 * Build the spending policy from validated env (group `x402`). The payer is
 * passed in, so a caller that never signs (the firewall check) does not have
 * to load the payer key's group. Lists default to "any discovered provider,
 * any capability"; the owner's UI can narrow them per task later.
 */
import type { LoadedEnv } from '@agent-economy/core';
import { assertPolicy, type PolicyNetwork, type SpendingPolicy } from './policy.ts';

export interface PolicyLists {
  readonly allowedProviders?: readonly string[] | null;
  readonly blockedProviders?: readonly string[];
  readonly allowedCapabilities?: readonly string[] | null;
}

export function spendingPolicyFromEnv(
  env: Pick<LoadedEnv, 'require'> & Partial<Pick<LoadedEnv, 'get'>>,
  payer: string,
  lists: PolicyLists = {},
): SpendingPolicy {
  return assertPolicy({
    network: env.require('X402_NETWORK') as PolicyNetwork,
    asset: env.require('X402_ASSET'),
    payer,
    maxPerPayment: BigInt(env.require('X402_MAX_PAYMENT_TINYBARS')),
    maxPerRun: BigInt(env.require('X402_RUN_BUDGET_TINYBARS')),
    maxPerDay: BigInt(env.require('X402_DAILY_BUDGET_TINYBARS')),
    maxPaymentsPerRun: Number(env.require('X402_MAX_PAYMENTS_PER_RUN')),
    maxSnapshotAgeMs: Number(env.require('X402_SNAPSHOT_MAX_AGE_SEC')) * 1000,
    allowedProviders: lists.allowedProviders ?? null,
    blockedProviders: lists.blockedProviders ?? [],
    allowedCapabilities: lists.allowedCapabilities ?? null,
    // the server's own kill switch (D-062): no saved owner policy can lift it
    ...(env.get?.('X402_PAYMENTS_PAUSED') === 'true' ? { paymentsPaused: true } : {}),
  });
}
