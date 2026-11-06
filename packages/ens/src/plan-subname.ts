/**
 * Subname planner: decide the next action to give `<label>.<parent>.eth` a
 * subregistry on the parent, its own resolver and text records. Pure; the
 * script gathers facts and executes the step.
 *
 * Order: deploy UserRegistry → setSubregistry on the ETHRegistry → setParent
 * on the UserRegistry (canonical path) → deploy the subname's resolver →
 * register the subname (resolver set, expiry = parent expiry) → fix the
 * resolver if it differs → set text records → done.
 */

export type SubnameStepKind =
  | 'LOW_ETH'
  | 'PARENT_NOT_REGISTERED'
  | 'SUBREGISTRY_EXISTS'
  | 'DEPLOY_REGISTRY'
  | 'SET_SUBREGISTRY'
  | 'SET_PARENT'
  | 'DEPLOY_SUB_RESOLVER'
  | 'REGISTER_SUBNAME'
  | 'SET_SUB_RESOLVER'
  | 'SET_TEXT'
  | 'DONE';

export interface SubnameFacts {
  readonly ethBalance: bigint;
  readonly minEth: bigint;
  readonly now: bigint;
  /** ETHRegistry.getExpiry(labelhash(parentLabel)). */
  readonly parentExpiry: bigint;
  /** ETHRegistry.getSubregistry(parentLabel); zero address when none. */
  readonly parentSubregistry: string;
  readonly ethRegistry: string;
  readonly parentLabel: string;
  /** registry.getParent(), when we have a registry. */
  readonly registryParent: { readonly parent: string; readonly label: string } | null;
  /** registry.getExpiry(labelhash(label)); 0n when unregistered or no registry. */
  readonly subExpiry: bigint;
  /** registry.getResolver(label); zero address when none. */
  readonly subResolverOnChain: string;
  readonly desiredText: Readonly<Record<string, string>>;
  readonly currentText: Readonly<Record<string, string | null>>;
}

export interface SubnameState {
  readonly registry: string | null;
  readonly subResolver: string | null;
}

export interface SubnameStep {
  readonly kind: SubnameStepKind;
  readonly reason: string;
  readonly key?: string;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  a.toLowerCase() === b.toLowerCase();

const TERMINAL: readonly SubnameStepKind[] = [
  'LOW_ETH',
  'PARENT_NOT_REGISTERED',
  'SUBREGISTRY_EXISTS',
  'DONE',
];
export const isSubnameTerminal = (k: SubnameStepKind): boolean => TERMINAL.includes(k);
export const SUBNAME_SENDS_TX: readonly SubnameStepKind[] = [
  'DEPLOY_REGISTRY',
  'SET_SUBREGISTRY',
  'SET_PARENT',
  'DEPLOY_SUB_RESOLVER',
  'REGISTER_SUBNAME',
  'SET_SUB_RESOLVER',
  'SET_TEXT',
];

function raw(f: SubnameFacts, s: SubnameState): SubnameStep {
  if (f.parentExpiry <= f.now) {
    return {
      kind: 'PARENT_NOT_REGISTERED',
      reason: 'the parent .eth name is not registered (or expired)',
    };
  }
  if (s.registry === null) {
    return same(f.parentSubregistry, ZERO)
      ? { kind: 'DEPLOY_REGISTRY', reason: 'the parent has no subregistry yet' }
      : {
          kind: 'SUBREGISTRY_EXISTS',
          reason: `the parent already points at subregistry ${f.parentSubregistry}; re-run with --registry <address> if it is yours`,
        };
  }
  if (!same(f.parentSubregistry, s.registry)) {
    return { kind: 'SET_SUBREGISTRY', reason: 'the parent does not point at our subregistry yet' };
  }
  if (
    f.registryParent === null ||
    !same(f.registryParent.parent, f.ethRegistry) ||
    f.registryParent.label !== f.parentLabel
  ) {
    return {
      kind: 'SET_PARENT',
      reason: 'the subregistry does not name its parent yet (canonical path)',
    };
  }
  if (s.subResolver === null) {
    return { kind: 'DEPLOY_SUB_RESOLVER', reason: 'the subname has no resolver of its own yet' };
  }
  if (f.subExpiry <= f.now) {
    return { kind: 'REGISTER_SUBNAME', reason: 'the subname is not registered in our subregistry' };
  }
  if (!same(f.subResolverOnChain, s.subResolver)) {
    return { kind: 'SET_SUB_RESOLVER', reason: 'the subname points at a different resolver' };
  }
  for (const [key, value] of Object.entries(f.desiredText)) {
    if (f.currentText[key] !== value) {
      return { kind: 'SET_TEXT', key, reason: `text "${key}" is not yet the desired value` };
    }
  }
  return {
    kind: 'DONE',
    reason: 'subname registered in our subregistry, with its own resolver and records',
  };
}

export function nextSubnameStep(f: SubnameFacts, s: SubnameState): SubnameStep {
  const step = raw(f, s);
  if (SUBNAME_SENDS_TX.includes(step.kind) && f.ethBalance < f.minEth) {
    return { kind: 'LOW_ETH', reason: `Sepolia ETH below ${f.minEth} wei; fund the wallet first` };
  }
  return step;
}
