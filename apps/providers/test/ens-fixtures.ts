// Shared fixtures: a served-agent config and ENS discovery entries that match it.
import type { DiscoverySnapshot } from '@agent-economy/ens';
import type { ServedAgent } from '../src/ens-check.ts';

export const SERVED: ServedAgent[] = [
  { label: 'kev', priceAtomic: '100000', payTo: '0.0.11044329' },
  { label: 'cve', priceAtomic: '150000', payTo: '0.0.11183141' },
];

type Provider = DiscoverySnapshot['providers'][number];
export function ensProvider(label: string, patch: Partial<Provider['provider']> = {}): Provider {
  const served = SERVED.find((s) => s.label === label);
  const provider = {
    ensName: `${label}.chirag126.eth`,
    label,
    chain: 'sepolia' as const,
    resolver: '0x1993BB58708a630AF1CC01304Dd851BDEccF9261',
    endpoint: `http://127.0.0.1:4021/v1/${label}`,
    capabilities: [`${label}-data`],
    payTo: served?.payTo ?? '0.0.1',
    network: 'hedera:testnet' as const,
    asset: '0.0.0',
    priceAtomic: served?.priceAtomic ?? '1',
    discoveredAt: '2026-10-27T00:00:00.000Z',
    ...patch,
  };
  return {
    label,
    name: provider.ensName,
    resolver: provider.resolver,
    registeredAtBlock: 1n,
    registrationTx: `0x${'ab'.repeat(32)}`,
    records: {
      endpoint: provider.endpoint,
      capabilities: provider.capabilities,
      priceAtomic: provider.priceAtomic,
      payTo: provider.payTo,
      network: provider.network,
      asset: provider.asset,
      status: 'active',
      context: null,
      description: null,
    },
    provider,
  } as Provider;
}
