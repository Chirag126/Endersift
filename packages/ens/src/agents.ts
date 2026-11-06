/**
 * The three provider agents this project publishes under ENS_PARENT_NAME, and
 * the exact text records each one should carry. Dependency-free.
 *
 * Labels match the Hedera payout accounts created by `pnpm hedera:create-providers`
 * (default labels kev, cve, osv), so `x402.payTo` comes from
 * HEDERA_PROVIDER_ACCOUNTS by label and never from this file.
 *
 * The data sources are the public feeds the provider services serve from
 * plan row 13; the records describe them now so discovery has real content.
 */
import {
  agentRecordsToText,
  type AgentRecordKey,
  type AgentRecords,
  type X402Network,
} from './records.ts';

export interface AgentDefinition {
  readonly label: string;
  readonly capabilities: readonly string[];
  /** Price per paid request, atomic units of x402.asset (tinybars for HBAR). */
  readonly priceAtomic: string;
  /** ENSIP-5 description: one line for people. */
  readonly description: string;
  /** ENSIP-26 agent-context: what an agent needs to know before paying. */
  readonly context: string;
}

const context = (source: string, returns: string, license: string): string =>
  [
    `Source: ${source}.`,
    `Returns: ${returns}.`,
    `License: ${license}.`,
    'Payment: x402 exact scheme on Hedera; see x402.* records. Pay only the account in x402.payTo.',
  ].join('\n');

export const AGENTS: readonly AgentDefinition[] = [
  {
    label: 'kev',
    capabilities: ['known-exploited-vulns', 'ransomware-use'],
    priceAtomic: '100000',
    description: 'CISA Known Exploited Vulnerabilities, served as a paid x402 API.',
    context: context(
      'CISA Known Exploited Vulnerabilities catalog (cisa.gov/known-exploited-vulnerabilities-catalog)',
      'KEV entries added or changed since a date, with vendor, product, due date and ransomware use',
      'public domain (US government work)',
    ),
  },
  {
    label: 'cve',
    capabilities: ['cve-details', 'cvss-scores'],
    priceAtomic: '150000',
    description: 'NVD CVE records with CVSS scores, served as a paid x402 API.',
    context: context(
      'NIST National Vulnerability Database CVE API 2.0 (nvd.nist.gov)',
      'CVE descriptions, CVSS v3/v4 metrics, CWE and references for requested CVE IDs',
      'NVD data is public; this product uses the NVD API but is not endorsed or certified by the NVD',
    ),
  },
  {
    label: 'osv',
    capabilities: ['ecosystem-advisories', 'package-vulns'],
    priceAtomic: '120000',
    description: 'OSV open-source package advisories, served as a paid x402 API.',
    context: context(
      'OSV.dev vulnerability database (osv.dev)',
      'advisories affecting requested packages and versions across npm, PyPI, Go, Maven and more',
      'OSV data is CC-BY 4.0 unless an advisory states otherwise',
    ),
  },
];

export interface AgentDeploymentInputs {
  /** Base URL the provider services are reachable at (no trailing slash added). */
  readonly endpointBase: string;
  readonly payToByLabel: ReadonlyMap<string, string>;
  readonly network: X402Network;
  readonly asset: string;
  /** Client-side cap; a price above it would be refused by every payer, so it is refused here. */
  readonly maxPriceAtomic: bigint;
}

export class AgentManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentManifestError';
  }
}

/** `${base}/v1/${label}`: the root the provider service mounts each agent's routes under. */
export function agentEndpoint(endpointBase: string, label: string): string {
  let u: URL;
  try {
    u = new URL(endpointBase);
  } catch {
    throw new AgentManifestError('the endpoint base is not a valid URL');
  }
  if (u.search !== '' || u.hash !== '') {
    throw new AgentManifestError('the endpoint base must not carry a query or fragment');
  }
  return `${endpointBase.replace(/\/+$/, '')}/v1/${label}`;
}

/** The parsed records an agent should publish. Throws on any manifest/env inconsistency. */
export function desiredAgentRecords(
  def: AgentDefinition,
  inputs: AgentDeploymentInputs,
): AgentRecords {
  const payTo = inputs.payToByLabel.get(def.label);
  if (payTo === undefined) {
    throw new AgentManifestError(
      `no Hedera payout account for "${def.label}" in HEDERA_PROVIDER_ACCOUNTS`,
    );
  }
  if (BigInt(def.priceAtomic) > inputs.maxPriceAtomic) {
    throw new AgentManifestError(
      `price of "${def.label}" is above X402_MAX_PAYMENT_TINYBARS; payers would refuse it`,
    );
  }
  return {
    endpoint: agentEndpoint(inputs.endpointBase, def.label),
    capabilities: [...def.capabilities].sort(),
    priceAtomic: def.priceAtomic,
    payTo,
    network: inputs.network,
    asset: inputs.asset,
    status: 'active',
    context: def.context,
    description: def.description,
  };
}

/** Canonical text values to publish, validated by the record parser (http only for localhost). */
export function desiredAgentText(
  def: AgentDefinition,
  inputs: AgentDeploymentInputs,
): Record<AgentRecordKey, string> {
  const text = agentRecordsToText(desiredAgentRecords(def, inputs), { allowLocalHttp: true });
  return text as Record<AgentRecordKey, string>;
}

/** Labels missing from HEDERA_PROVIDER_ACCOUNTS, in manifest order. */
export function missingPayoutLabels(payToByLabel: ReadonlyMap<string, string>): string[] {
  return AGENTS.filter((a) => !payToByLabel.has(a.label)).map((a) => a.label);
}
