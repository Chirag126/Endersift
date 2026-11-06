/**
 * Turn an agent's parsed ENS records into the domain ProviderAgent. Only
 * `active` agents become purchasable providers; the result is re-validated
 * with the zod domain schema, so discovery can never hand the firewall an
 * object the domain model would reject.
 */
import { ProviderAgent, isLoopbackHttpUrl } from '@agent-economy/core/domain';
import type { AgentRecords } from './records.ts';

export type ProviderResult =
  | { readonly ok: true; readonly provider: ProviderAgent }
  | { readonly ok: false; readonly reason: string };

export function toProviderAgent(input: {
  readonly ensName: string;
  readonly label: string;
  readonly chain: 'sepolia' | 'mainnet';
  readonly resolver: string;
  readonly records: AgentRecords;
  readonly discoveredAt: string;
  /** Accept http on a loopback host (local development only, D-035). Default false. */
  readonly allowLocalHttp?: boolean;
}): ProviderResult {
  if (input.records.status !== 'active') {
    return { ok: false, reason: `agent.status is ${input.records.status}, not active` };
  }
  if (input.allowLocalHttp !== true && isLoopbackHttpUrl(input.records.endpoint)) {
    return {
      ok: false,
      reason: 'endpoint: a loopback http endpoint is accepted only in local mode',
    };
  }
  const parsed = ProviderAgent.safeParse({
    ensName: input.ensName,
    label: input.label,
    chain: input.chain,
    resolver: input.resolver,
    endpoint: input.records.endpoint,
    capabilities: [...input.records.capabilities],
    payTo: input.records.payTo,
    network: input.records.network,
    asset: input.records.asset,
    priceAtomic: input.records.priceAtomic,
    discoveredAt: input.discoveredAt,
  });
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, provider: parsed.data };
}
