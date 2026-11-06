/**
 * deployments/<chain>.json: the committed, public description of what is
 * provisioned on chain. Built only from verified chain state, with no
 * timestamps or transaction hashes, so re-provisioning a converged
 * deployment produces a byte-identical file (rerun = no-op, visible in git).
 * Transaction hashes belong in docs/evidence/, not here. Dependency-free.
 */

export interface DeployedAgent {
  readonly label: string;
  readonly name: string;
  readonly resolver: string;
  /** Subname expiry (unix seconds, decimal string): the parent's expiry at registration. */
  readonly expiry: string;
  readonly operator: string;
  /** Record keys the operator may write (ROLE_SET_TEXT per key on this resolver). */
  readonly operatorKeys: readonly string[];
  /** Record keys only the admin may write. */
  readonly adminKeys: readonly string[];
  /** Published text records, in record-spec order; empty values omitted. */
  readonly records: Readonly<Record<string, string>>;
}

export interface Deployment {
  readonly kind: 'ens-deployment';
  readonly version: 1;
  readonly chain: 'sepolia';
  readonly chainId: number;
  readonly parent: string;
  readonly admin: string;
  readonly contracts: Readonly<Record<string, string>>;
  readonly subregistry: string;
  readonly agents: readonly DeployedAgent[];
}

/** Stable serialisation (2-space JSON, trailing newline): equal deployments give equal bytes. */
export function serializeDeployment(d: Deployment): string {
  return `${JSON.stringify(d, null, 2)}\n`;
}

/** Checksummed addresses compare case-insensitively; everything else exactly. */
export function sameDeployment(a: Deployment, b: Deployment): boolean {
  return serializeDeployment(normalize(a)) === serializeDeployment(normalize(b));
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const lc = (v: string): string => (ADDRESS.test(v) ? v.toLowerCase() : v);

function normalize(d: Deployment): Deployment {
  return {
    ...d,
    admin: lc(d.admin),
    subregistry: lc(d.subregistry),
    contracts: Object.fromEntries(Object.entries(d.contracts).map(([k, v]) => [k, lc(v)])),
    agents: d.agents.map((a) => ({ ...a, resolver: lc(a.resolver), operator: lc(a.operator) })),
  };
}

export class DeploymentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeploymentFileError';
  }
}

/** Parse a committed deployment file far enough to reuse it (operators, comparison). */
export function parseDeployment(text: string): Deployment {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DeploymentFileError('the deployment file is not valid JSON');
  }
  const d = data as Partial<Deployment>;
  if (d.kind !== 'ens-deployment' || d.version !== 1) {
    throw new DeploymentFileError('the deployment file has an unknown kind or version');
  }
  if (!Array.isArray(d.agents)) throw new DeploymentFileError('the deployment file has no agents');
  for (const a of d.agents) {
    if (
      typeof a?.label !== 'string' ||
      typeof a.operator !== 'string' ||
      !ADDRESS.test(a.operator) ||
      typeof a.resolver !== 'string' ||
      !ADDRESS.test(a.resolver)
    ) {
      throw new DeploymentFileError('the deployment file has a malformed agent entry');
    }
  }
  return d as Deployment;
}

/** Text records to publish in the file: spec order, empty values dropped. */
export function publishedRecords(
  recordKeys: readonly string[],
  text: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of recordKeys) {
    const v = text[k] ?? '';
    if (v !== '') out[k] = v;
  }
  return out;
}
