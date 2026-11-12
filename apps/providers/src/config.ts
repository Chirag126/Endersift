/**
 * Provider service configuration, built only from secret-free env groups:
 * the provider server never sees the payer's private key.
 */
import {
  loadEnv,
  parseLabelledAccounts,
  parseNearLabelledAccounts,
  type EnvSource,
} from '@agent-economy/core';
import { AGENTS } from '@agent-economy/ens/agents';
import { USDC_TOKEN_ID } from '@agent-economy/hedera/units';
import { parseNear, type NearNetwork } from '@agent-economy/near';
import type { HederaCaip2 } from '@agent-economy/hedera/x402';

export interface ProviderConfig {
  readonly network: HederaCaip2;
  readonly facilitatorUrl: string;
  readonly port: number;
  readonly priceTinybars: bigint;
  readonly label: string;
  readonly payTo: string;
}

/** Load config for one provider label (default: the first configured provider). */
export function loadProviderConfig(source: EnvSource, label?: string): ProviderConfig {
  const env = loadEnv(['providers'], source); // pulls in x402, hedera-providers, hedera-network
  const providers = parseLabelledAccounts(env.require('HEDERA_PROVIDER_ACCOUNTS'));
  if (typeof providers === 'string' || providers.length === 0) {
    throw new Error('HEDERA_PROVIDER_ACCOUNTS must list at least one provider');
  }
  const chosen = label === undefined ? providers[0] : providers.find((p) => p.label === label);
  if (chosen === undefined) throw new Error(`provider label "${label}" is not configured`);

  return {
    network: env.require('X402_NETWORK') as HederaCaip2,
    facilitatorUrl: env.require('X402_FACILITATOR_URL'),
    port: Number(env.require('PROVIDERS_PORT')),
    priceTinybars: BigInt(env.require('X402_DEMO_PRICE_TINYBARS')),
    label: chosen.label,
    payTo: chosen.accountId,
  };
}

export interface IntelServiceConfig {
  readonly network: HederaCaip2;
  readonly facilitatorUrl: string;
  /** X402_FALLBACK_FACILITATOR_URL, bound at startup only if the primary is unavailable. */
  readonly fallbackFacilitatorUrl: string | undefined;
  /** Settlement asset (X402_ASSET); the provider routes charge HBAR (0.0.0). */
  readonly asset: string;
  readonly port: number;
  /** Public base URL the ENS endpoints point at (PROVIDERS_PUBLIC_URL, default http://127.0.0.1:<port>). */
  readonly publicUrl: string;
  readonly production: boolean;
  readonly pingPriceTinybars: bigint;
  /** The USDC lane (D-064): Circle USDC on this network at this atomic price, or null. */
  readonly usdcPing: { readonly tokenId: string; readonly priceAtomic: bigint } | null;
  /** Every agent of the manifest, with its payout account and its ENS price. */
  readonly providers: readonly { label: string; payTo: string; priceAtomic: string }[];
  /**
   * The agent's brief for sale (D-066): price, payee (the agent's earnings
   * account) and where the brief is read; null = not for sale.
   */
  /** The agent's public URL (AGENT_PUBLIC_URL), named in its ERC-8004 registration file; or null. */
  readonly agentUrl: string | null;
  readonly briefSale: {
    readonly priceTinybars: bigint;
    readonly payTo: string;
    readonly agentUrl: string;
  } | null;
  readonly nvdApiKey: string | undefined;
}

/**
 * Config for the threat-intel service: prices come from the same agent
 * manifest that provisioning publishes to ENS (`agent.price`), payout
 * accounts from HEDERA_PROVIDER_ACCOUNTS by label (as `x402.payTo`), so the
 * 402 quotes match the ENS records. Every manifest agent must have an account.
 */
export function loadIntelConfig(source: EnvSource): IntelServiceConfig {
  const env = loadEnv(['core', 'providers'], source);
  const accounts = parseLabelledAccounts(env.require('HEDERA_PROVIDER_ACCOUNTS'));
  if (typeof accounts === 'string') throw new Error(`HEDERA_PROVIDER_ACCOUNTS ${accounts}`);
  const byLabel = new Map(accounts.map((a) => [a.label, a.accountId]));
  const missing = AGENTS.filter((a) => !byLabel.has(a.label)).map((a) => a.label);
  if (missing.length > 0) {
    throw new Error(`HEDERA_PROVIDER_ACCOUNTS has no payout account for: ${missing.join(', ')}`);
  }
  const nvdApiKey = env.get('NVD_API_KEY');
  const asset = env.require('X402_ASSET');
  if (asset !== '0.0.0') {
    throw new Error(
      'the provider routes charge HBAR; set X402_ASSET=0.0.0 (HTS settlement is plan row 37)',
    );
  }
  const port = Number(env.require('PROVIDERS_PORT'));
  const fallback = env.get('X402_FALLBACK_FACILITATOR_URL');
  const publicUrl = (env.get('PROVIDERS_PUBLIC_URL') ?? `http://127.0.0.1:${port}`).replace(
    /\/+$/,
    '',
  );
  const production = env.require('NODE_ENV') === 'production';
  // a deployed provider must be reachable over https at the URL its ENS records name (D-062)
  if (production && !publicUrl.startsWith('https://'))
    throw new Error(
      'PROVIDERS_PUBLIC_URL must be the https URL of this service in production (its ENS endpoints point there)',
    );
  return {
    network: env.require('X402_NETWORK') as HederaCaip2,
    facilitatorUrl: env.require('X402_FACILITATOR_URL'),
    fallbackFacilitatorUrl: fallback === undefined || fallback.trim() === '' ? undefined : fallback,
    asset,
    port,
    publicUrl,
    production,
    pingPriceTinybars: BigInt(env.require('X402_DEMO_PRICE_TINYBARS')),
    usdcPing: (() => {
      const price = env.get('X402_USDC_PING_ATOMIC');
      if (price === undefined) return null;
      const network = env.require('X402_NETWORK');
      return {
        tokenId: network === 'hedera:mainnet' ? USDC_TOKEN_ID.mainnet : USDC_TOKEN_ID.testnet,
        priceAtomic: BigInt(price),
      };
    })(),
    providers: AGENTS.map((a) => ({
      label: a.label,
      payTo: byLabel.get(a.label) as string,
      priceAtomic: a.priceAtomic,
    })),
    nvdApiKey: nvdApiKey === undefined || nvdApiKey.trim() === '' ? undefined : nvdApiKey,
    agentUrl: env.get('AGENT_PUBLIC_URL')?.replace(/\/+$/, '') ?? null,
    briefSale: (() => {
      const price = env.get('BRIEF_SALE_PRICE_TINYBARS');
      if (price === undefined) return null;
      // loadEnv's cross-field check already requires both when a price is set
      const payTo = env.require('AGENT_EARNINGS_ACCOUNT');
      const agentUrl = env.require('AGENT_PUBLIC_URL').replace(/\/+$/, '');
      if (production && !agentUrl.startsWith('https://'))
        throw new Error('AGENT_PUBLIC_URL must be the https URL of the agent in production');
      if (accounts.some((a) => a.accountId === payTo))
        throw new Error('AGENT_EARNINGS_ACCOUNT must not be a provider payout account');
      return { priceTinybars: BigInt(price), payTo, agentUrl };
    })(),
  };
}

export interface NearLaneConfig {
  readonly network: NearNetwork;
  readonly nodeUrl: string;
  readonly guard: string;
  readonly priceYocto: bigint;
  /** label → NEAR payout account. */
  readonly accounts: Readonly<Record<string, string>>;
}

/**
 * The NEAR pay lane's settings, or null when it is not configured (no
 * NEAR_GUARD_CONTRACT_ID): the service then runs exactly as before.
 */
export function loadNearLaneConfig(source: EnvSource): NearLaneConfig | null {
  const guard = source['NEAR_GUARD_CONTRACT_ID'];
  if (guard === undefined || guard.trim() === '') return null;
  const env = loadEnv(['near-providers'], source);
  const accounts = parseNearLabelledAccounts(env.require('NEAR_PROVIDER_ACCOUNTS'));
  if (typeof accounts === 'string') throw new Error(`NEAR_PROVIDER_ACCOUNTS ${accounts}`);
  return {
    network: `near:${env.require('NEAR_NETWORK')}` as NearNetwork,
    nodeUrl: env.require('NEAR_NODE_URL'),
    guard: env.require('NEAR_GUARD_CONTRACT_ID'),
    priceYocto: parseNear(env.require('NEAR_PRICE')),
    accounts: Object.fromEntries(accounts.map((a) => [a.label, a.accountId])),
  };
}
