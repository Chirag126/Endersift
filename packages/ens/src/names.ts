/** Name helpers: parent-label parsing, DNS encoding, deterministic resolver salt. */
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from 'viem';
import { labelhash, namehash, normalize, packetToBytes } from 'viem/ens';

export class EnsNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnsNameError';
  }
}

/**
 * The registrable label of a second-level .eth name ("kevagents.eth" →
 * "kevagents"). Throws for subnames, other TLDs, names that change under
 * ENS normalisation, or labels the ETHRegistrar would price prohibitively
 * (under 3 characters).
 */
export function parseParentLabel(name: string): { name: string; label: string } {
  let normalized: string;
  try {
    normalized = normalize(name);
  } catch {
    throw new EnsNameError('ENS_PARENT_NAME is not a valid ENS name');
  }
  if (normalized !== name) {
    throw new EnsNameError(
      'ENS_PARENT_NAME must already be in normalised form (lowercase, no spaces)',
    );
  }
  const parts = normalized.split('.');
  if (parts.length !== 2 || parts[1] !== 'eth' || parts[0] === undefined || parts[0] === '') {
    throw new EnsNameError('ENS_PARENT_NAME must be a second-level .eth name like myagents.eth');
  }
  const label = parts[0];
  if ([...label].length < 3) throw new EnsNameError('the label must be at least 3 characters');
  return { name: normalized, label };
}

/** DNS wire-format encoding, as PermissionedResolver setters expect (not a namehash). */
export function dnsEncode(name: string): Hex {
  return toHex(packetToBytes(name));
}

/**
 * Salt for this owner's resolver proxy, following the scheme in the ENS docs:
 * keccak256(abi.encode(keccak256("OwnedResolver"), owner, version)). The
 * factory mixes in msg.sender too, so salts never collide across deployers.
 */
export function ownedResolverSalt(owner: Address, version = 0n): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [keccak256(toHex('OwnedResolver')), owner, version],
      ),
    ),
  );
}

/** A single child label (e.g. "kev"): normalised, 2-63 chars, letters, digits and hyphens. */
export function parseChildLabel(label: string): string {
  let normalized: string;
  try {
    normalized = normalize(label);
  } catch {
    throw new EnsNameError('the subname label is not a valid ENS label');
  }
  if (
    normalized !== label ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ||
    label.length < 2
  ) {
    throw new EnsNameError(
      'the subname label must be 2-63 lowercase letters, digits or inner hyphens',
    );
  }
  return label;
}

/** uint256(keccak256(label)): the `anyId` registries accept for a label (LibLabel.id). */
export function labelId(label: string): bigint {
  return BigInt(labelhash(label));
}

const saltFor = (kind: string, name: string, version: bigint): bigint =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
        [keccak256(toHex(kind)), namehash(name), version],
      ),
    ),
  );

/** Salt for the subregistry of `name`, per the docs: keccak256("UserRegistry", namehash, version). */
export function userRegistrySalt(name: string, version = 0n): bigint {
  return saltFor('UserRegistry', name, version);
}

/** Salt for a per-agent resolver, one per subname (roles are scoped per resolver instance). */
export function agentResolverSalt(fullName: string, version = 0n): bigint {
  return saltFor('AgentResolver', fullName, version);
}

/**
 * EAC resource for a text key on a PermissionedResolver:
 * uint256(keccak256(bytes(key))) (PermissionedResolverLib.resource(string)).
 * Roles on it apply to that key on every name the resolver serves, which is
 * why each agent has its own resolver.
 */
export function textKeyResource(key: string): bigint {
  return BigInt(keccak256(toHex(key)));
}
