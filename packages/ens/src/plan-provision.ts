/**
 * Provisioning planner (plan row 12): decide the next action that moves the
 * on-chain state toward "every agent registered under our subregistry, with
 * its own resolver, the desired records, and exactly the desired operator
 * roles". Pure and dependency-free; the script gathers facts from the chain
 * and executes one step at a time.
 *
 * Every fact comes from chain state (predicted proxy addresses, role reads,
 * record reads), never from a local file, so a rerun on a converged
 * deployment yields DONE with zero transactions.
 *
 * Order: subregistry (deploy → link from the parent → canonical parent), then
 * per agent: resolver → registration → resolver pointer → records →
 * revoke excess operator roles → grant missing operator roles.
 */

export type ProvisionStepKind =
  | 'LOW_ETH'
  | 'PARENT_NOT_REGISTERED'
  | 'FOREIGN_SUBREGISTRY'
  | 'FOREIGN_RESOLVER'
  | 'DEPLOY_REGISTRY'
  | 'SET_SUBREGISTRY'
  | 'SET_PARENT'
  | 'DEPLOY_RESOLVER'
  | 'REGISTER_SUBNAME'
  | 'SET_RESOLVER'
  | 'SET_RECORDS'
  | 'REVOKE_ROLES'
  | 'GRANT_ROLES'
  | 'DONE';

/** One role change for one operator on one record key (`null` key = root resource). */
export interface RoleChange {
  readonly key: string | null;
  readonly bits: bigint;
}

export interface AgentFacts {
  readonly label: string;
  /** VerifiableFactory.predictProxyAddress(admin, agentResolverSalt(name)). */
  readonly resolver: string;
  readonly resolverDeployed: boolean;
  /** The admin holds SET_TEXT and its admin role on the resolver's root resource. */
  readonly adminControlsResolver: boolean;
  /** registry.getExpiry(labelId(label)); 0n when unregistered. */
  readonly subExpiry: bigint;
  /** registry.getResolver(label). */
  readonly resolverOnChain: string;
  /** Current text per record key ('' when unset). Only meaningful once the resolver exists. */
  readonly currentText: Readonly<Record<string, string>>;
  readonly desiredText: Readonly<Record<string, string>>;
  /** Operator address, or null when not generated yet (dry run before the first --confirm). */
  readonly operator: string | null;
  /** roles(resource(key), operator) per record key. */
  readonly operatorRoles: Readonly<Record<string, bigint>>;
  /** roles(ROOT_RESOURCE, operator). */
  readonly operatorRootRoles: bigint;
}

export interface ProvisionFacts {
  readonly ethBalance: bigint;
  readonly minEth: bigint;
  readonly now: bigint;
  readonly parentLabel: string;
  readonly ethRegistry: string;
  /** ETHRegistry.getExpiry(labelId(parentLabel)). */
  readonly parentExpiry: bigint;
  /** ETHRegistry.getSubregistry(parentLabel). */
  readonly parentSubregistry: string;
  /** predictProxyAddress(admin, userRegistrySalt(parent)). */
  readonly registry: string;
  readonly registryDeployed: boolean;
  /** The admin holds REGISTRAR on the registry's root resource. */
  readonly adminControlsRegistry: boolean;
  /** registry.getParent(), when deployed. */
  readonly registryParent: { readonly parent: string; readonly label: string } | null;
  /** Every record key the parser knows (current values are compared over all of them). */
  readonly recordKeys: readonly string[];
  /** Keys an operator may write; all others are admin-only. */
  readonly operatorKeys: readonly string[];
  /** The role an operator receives on each operator key (ROLE_SET_TEXT). */
  readonly operatorRole: bigint;
  readonly agents: readonly AgentFacts[];
}

export interface ProvisionStep {
  readonly kind: ProvisionStepKind;
  readonly reason: string;
  readonly agent?: string;
  /** SET_RECORDS: the keys to write (value from desiredText, '' clears). */
  readonly keys?: readonly string[];
  /** REVOKE_ROLES / GRANT_ROLES. */
  readonly changes?: readonly RoleChange[];
}

export const ZERO_ADDRESS_LC = '0x0000000000000000000000000000000000000000';
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const TERMINAL: readonly ProvisionStepKind[] = [
  'LOW_ETH',
  'PARENT_NOT_REGISTERED',
  'FOREIGN_SUBREGISTRY',
  'FOREIGN_RESOLVER',
  'DONE',
];
export const isProvisionTerminal = (k: ProvisionStepKind): boolean => TERMINAL.includes(k);
export const PROVISION_SENDS_TX: readonly ProvisionStepKind[] = [
  'DEPLOY_REGISTRY',
  'SET_SUBREGISTRY',
  'SET_PARENT',
  'DEPLOY_RESOLVER',
  'REGISTER_SUBNAME',
  'SET_RESOLVER',
  'SET_RECORDS',
  'REVOKE_ROLES',
  'GRANT_ROLES',
];

/** Keys whose current value differs from the desired one ('' desired = must be empty). */
export function recordsToWrite(
  recordKeys: readonly string[],
  current: Readonly<Record<string, string>>,
  desired: Readonly<Record<string, string>>,
): string[] {
  return recordKeys.filter((k) => (current[k] ?? '') !== (desired[k] ?? ''));
}

/** The exact operator roles wanted: `operatorRole` on operator keys, nothing elsewhere. */
export function roleDiff(
  f: Pick<ProvisionFacts, 'recordKeys' | 'operatorKeys' | 'operatorRole'>,
  a: Pick<AgentFacts, 'operatorRoles' | 'operatorRootRoles'>,
): { revoke: RoleChange[]; grant: RoleChange[] } {
  const revoke: RoleChange[] = [];
  const grant: RoleChange[] = [];
  if (a.operatorRootRoles !== 0n) revoke.push({ key: null, bits: a.operatorRootRoles });
  for (const key of f.recordKeys) {
    const have = a.operatorRoles[key] ?? 0n;
    const want = f.operatorKeys.includes(key) ? f.operatorRole : 0n;
    const excess = have & ~want;
    const missing = want & ~have;
    if (excess !== 0n) revoke.push({ key, bits: excess });
    if (missing !== 0n) grant.push({ key, bits: missing });
  }
  return { revoke, grant };
}

function agentStep(f: ProvisionFacts, a: AgentFacts): ProvisionStep | null {
  const agent = a.label;
  if (!a.resolverDeployed) {
    return { kind: 'DEPLOY_RESOLVER', agent, reason: 'the agent has no resolver of its own yet' };
  }
  if (!a.adminControlsResolver) {
    return {
      kind: 'FOREIGN_RESOLVER',
      agent,
      reason: `the predicted resolver ${a.resolver} exists but the admin does not control it`,
    };
  }
  if (a.subExpiry <= f.now) {
    return {
      kind: 'REGISTER_SUBNAME',
      agent,
      reason: 'the subname is not registered (or expired)',
    };
  }
  if (!same(a.resolverOnChain, a.resolver)) {
    return { kind: 'SET_RESOLVER', agent, reason: 'the subname points at a different resolver' };
  }
  const keys = recordsToWrite(f.recordKeys, a.currentText, a.desiredText);
  if (keys.length > 0) {
    return {
      kind: 'SET_RECORDS',
      agent,
      keys,
      reason: `${keys.length} record(s) differ from the manifest`,
    };
  }
  const { revoke, grant } = roleDiff(f, a);
  if (revoke.length > 0) {
    return {
      kind: 'REVOKE_ROLES',
      agent,
      changes: revoke,
      reason: 'the operator holds roles beyond its delegated keys',
    };
  }
  if (grant.length > 0) {
    return {
      kind: 'GRANT_ROLES',
      agent,
      changes: grant,
      reason: `the operator lacks SET_TEXT on ${grant.length} delegated key(s)`,
    };
  }
  return null;
}

function raw(f: ProvisionFacts): ProvisionStep {
  if (f.parentExpiry <= f.now) {
    return {
      kind: 'PARENT_NOT_REGISTERED',
      reason: 'the parent .eth name is not registered (or expired)',
    };
  }
  const parentLinked = same(f.parentSubregistry, f.registry);
  if (!parentLinked && !same(f.parentSubregistry, ZERO_ADDRESS_LC)) {
    return {
      kind: 'FOREIGN_SUBREGISTRY',
      reason: `the parent points at subregistry ${f.parentSubregistry}, not ours (${f.registry}); refusing to overwrite`,
    };
  }
  if (!f.registryDeployed) {
    return { kind: 'DEPLOY_REGISTRY', reason: 'our subregistry is not deployed yet' };
  }
  if (!f.adminControlsRegistry) {
    return {
      kind: 'FOREIGN_SUBREGISTRY',
      reason: `the predicted subregistry ${f.registry} exists but the admin does not control it`,
    };
  }
  if (!parentLinked) {
    return { kind: 'SET_SUBREGISTRY', reason: 'the parent does not point at our subregistry yet' };
  }
  if (
    f.registryParent === null ||
    !same(f.registryParent.parent, f.ethRegistry) ||
    f.registryParent.label !== f.parentLabel
  ) {
    return {
      kind: 'SET_PARENT',
      reason: 'the subregistry does not name its parent (canonical path)',
    };
  }
  for (const a of f.agents) {
    const step = agentStep(f, a);
    if (step !== null) return step;
  }
  return {
    kind: 'DONE',
    reason: `all ${f.agents.length} agents registered with their own resolvers, records and operator roles`,
  };
}

export function nextProvisionStep(f: ProvisionFacts): ProvisionStep {
  const step = raw(f);
  if (PROVISION_SENDS_TX.includes(step.kind) && f.ethBalance < f.minEth) {
    return {
      kind: 'LOW_ETH',
      reason: `Sepolia ETH below ${f.minEth} wei; fund the admin wallet first`,
    };
  }
  return step;
}
