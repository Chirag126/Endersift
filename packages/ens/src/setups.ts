/**
 * ENSv2 subname setups beyond the provider agents (D-066), shown with the
 * providers and proven on Sepolia by `pnpm ens:setups`. Dependency-free.
 *
 *   expiring     a trial listing registered with a short expiry; once it
 *                passes, the registry treats the name as AVAILABLE and
 *                discovery skips it (NOT_REGISTERED), with no code change
 *   transferable registered with ROLE_CAN_TRANSFER_ADMIN; moved to another
 *                account with unsafeTransfer (the registry is not emancipated,
 *                so the "safe" ERC-1155 transfer is refused by design)
 *   locked       registered without ROLE_CAN_TRANSFER_ADMIN: a transfer
 *                reverts TransferDisallowed
 *   wildcard     the parent resolver's default record (the root name 0x00):
 *                any name under the parent without its own record resolves to
 *                it through the Universal Resolver (ENSIP-10)
 *   alias        linkToNode: a second name shares the parent's record bundle
 *
 * Semantics checked against ensdomains/contracts-v2 at the deployed commit
 * (PR #460 head, 2026-10-01): PermissionedRegistry.sol (_update, unsafeTransfer,
 * getStatus), RegistryRolesLib.sol, PermissionedResolver.sol (linkToNode,
 * _record's default), LibResolution.sol (findUnvalidatedResolver).
 *
 * None of these touches kev, cve or osv: new labels only, and only the parent
 * resolver gains a default record and a link (its own records are unchanged).
 * "Forever" names (no parent control) are not here: they need a registry
 * whose root roles are renounced (emancipated), which would be a separate
 * deployment.
 */
import { REGISTRY_ROLES, ROLE_CAN_TRANSFER_ADMIN } from './constants.ts';

export const SETUP_KINDS = ['expiring', 'transferable', 'locked', 'wildcard', 'alias'] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

const withAdmin = (roles: readonly bigint[]): bigint =>
  roles.reduce((acc, r) => acc | r | (r << 128n), 0n);

/** Token roles for a subname that can be moved to another owner. */
export const TRANSFERABLE_ROLES: bigint =
  withAdmin([REGISTRY_ROLES.SET_SUBREGISTRY, REGISTRY_ROLES.SET_RESOLVER]) |
  ROLE_CAN_TRANSFER_ADMIN;
/** The same roles without the transfer right: the token cannot leave its owner. */
export const LOCKED_ROLES: bigint = withAdmin([
  REGISTRY_ROLES.SET_SUBREGISTRY,
  REGISTRY_ROLES.SET_RESOLVER,
]);

/** One proven setup, as recorded in deployments/sepolia-setups.json. */
export interface EnsSetup {
  readonly kind: SetupKind;
  readonly name: string;
  /** Unix seconds (decimal string) for registered names; null for wildcard and alias. */
  readonly expiry: string | null;
  /** Owner after the setup (registered names); null otherwise. */
  readonly owner: string | null;
  /** What was verified, in one sentence. */
  readonly proof: string;
}

export interface EnsSetupsRecord {
  readonly kind: 'ens-setups';
  readonly version: 1;
  readonly parent: string;
  readonly subregistry: string;
  readonly parentResolver: string;
  readonly setups: readonly EnsSetup[];
}

export const SETUPS_PATH = 'deployments/sepolia-setups.json';

/** Labels for one run of the script (`stamp` e.g. 20261029t010203z). Pure. */
export function setupLabels(stamp: string): Readonly<Record<SetupKind, string>> {
  const s = stamp.toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    expiring: `trial-${s}`,
    transferable: `movable-${s}`,
    locked: `locked-${s}`,
    wildcard: `unlisted-${s}`,
    alias: `directory-${s}`,
  };
}

/** The trial's expiry: `minutes` from `nowSeconds`, between 10 minutes and 7 days. Pure. */
export function trialExpiry(nowSeconds: bigint, minutes: number): bigint {
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 7 * 24 * 60)
    throw new RangeError('the trial must last 10 minutes to 7 days');
  return nowSeconds + BigInt(minutes * 60);
}

/** Stable serialisation (setups in kind order, then name). */
export function serializeSetups(r: EnsSetupsRecord): string {
  const order = (k: SetupKind) => SETUP_KINDS.indexOf(k);
  const setups = [...r.setups].sort(
    (a, b) => order(a.kind) - order(b.kind) || a.name.localeCompare(b.name),
  );
  return `${JSON.stringify({ ...r, setups }, null, 2)}\n`;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read the record defensively; null when absent or malformed. Pure. */
export function parseSetups(raw: unknown): EnsSetupsRecord | null {
  if (!isRecord(raw) || raw['kind'] !== 'ens-setups' || raw['version'] !== 1) return null;
  const { parent, subregistry, parentResolver, setups } = raw;
  if (typeof parent !== 'string' || typeof subregistry !== 'string') return null;
  if (typeof parentResolver !== 'string' || !ADDRESS.test(parentResolver)) return null;
  if (!ADDRESS.test(subregistry) || !Array.isArray(setups)) return null;
  const out: EnsSetup[] = [];
  for (const s of setups) {
    if (!isRecord(s)) return null;
    const { kind, name, expiry, owner, proof } = s;
    if (typeof kind !== 'string' || !(SETUP_KINDS as readonly string[]).includes(kind)) return null;
    if (typeof name !== 'string' || !name.endsWith(`.${parent}`) || name.length > 255) return null;
    if (expiry !== null && (typeof expiry !== 'string' || !/^\d{1,20}$/.test(expiry))) return null;
    if (owner !== null && (typeof owner !== 'string' || !ADDRESS.test(owner))) return null;
    if (typeof proof !== 'string' || proof.length > 300) return null;
    out.push({ kind: kind as SetupKind, name, expiry, owner, proof });
  }
  return { kind: 'ens-setups', version: 1, parent, subregistry, parentResolver, setups: out };
}
