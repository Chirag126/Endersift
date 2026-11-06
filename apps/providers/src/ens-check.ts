/**
 * Startup check (plan row 16): what this service will charge must be what
 * ENS publishes. For every served agent the live ENS records (discovered from
 * chain, D-035) must exist, be purchasable, and match exactly:
 *   agent.price = route price · x402.payTo = route payTo ·
 *   x402.network = X402_NETWORK · x402.asset = HBAR (0.0.0) ·
 *   agent.endpoint = <public URL>/v1/<label>
 * Any mismatch refuses startup: a payer that discovered the agent in ENS
 * would otherwise be quoted a different price or asked to pay another account
 * (its firewall would refuse, and the agent would look broken or malicious).
 * Pure; the caller supplies the discovery snapshot.
 */
import type { DiscoverySnapshot } from '@agent-economy/ens';

export interface ServedAgent {
  readonly label: string;
  readonly priceAtomic: string;
  readonly payTo: string;
}

export const MISMATCH_FIELDS = [
  'missing',
  'agent.price',
  'x402.payTo',
  'x402.network',
  'x402.asset',
  'agent.endpoint',
] as const;
export type MismatchField = (typeof MISMATCH_FIELDS)[number];

export interface EnsMismatch {
  readonly label: string;
  readonly field: MismatchField;
  readonly service: string;
  readonly ens: string;
}

export function compareWithEns(input: {
  readonly served: readonly ServedAgent[];
  readonly network: string;
  readonly asset: string;
  /** Public base URL of this service, without a trailing slash. */
  readonly publicUrl: string;
  readonly snapshot: Pick<DiscoverySnapshot, 'providers' | 'skipped'>;
}): EnsMismatch[] {
  const out: EnsMismatch[] = [];
  for (const agent of input.served) {
    const found = input.snapshot.providers.find((p) => p.label === agent.label);
    if (found === undefined) {
      const skipped = input.snapshot.skipped.find((s) => s.label === agent.label);
      out.push({
        label: agent.label,
        field: 'missing',
        service: 'served',
        ens:
          skipped === undefined
            ? 'not registered in the subregistry'
            : `${skipped.code}: ${skipped.reason}`,
      });
      continue;
    }
    const p = found.provider;
    const expect = (field: EnsMismatch['field'], service: string, ens: string) => {
      if (service !== ens) out.push({ label: agent.label, field, service, ens });
    };
    expect('agent.price', agent.priceAtomic, p.priceAtomic);
    expect('x402.payTo', agent.payTo, p.payTo);
    expect('x402.network', input.network, p.network);
    expect('x402.asset', input.asset, p.asset);
    expect(
      'agent.endpoint',
      `${input.publicUrl.replace(/\/+$/, '')}/v1/${agent.label}`,
      p.endpoint,
    );
  }
  return out;
}

export class EnsMismatchError extends Error {
  readonly mismatches: readonly EnsMismatch[];

  constructor(mismatches: readonly EnsMismatch[]) {
    super(
      `refusing to start: ${mismatches.length} difference(s) between this service and ENS:\n` +
        mismatches
          .map((m) =>
            m.field === 'missing'
              ? `  ${m.label}: not a purchasable agent in ENS (${m.ens})`
              : `  ${m.label}: ${m.field} is ${m.service} here but ${m.ens} in ENS`,
          )
          .join('\n') +
        '\nFix the env (HEDERA_PROVIDER_ACCOUNTS, X402_*, PROVIDERS_PUBLIC_URL) or re-run `pnpm ens:provision -- --confirm`.',
    );
    this.name = 'EnsMismatchError';
    this.mismatches = mismatches;
  }
}
