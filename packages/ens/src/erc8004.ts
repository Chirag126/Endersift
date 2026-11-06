/**
 * ERC-8004 ("Trustless Agents") identity for this project's agents (D-066).
 * Dependency-free: used by the provider service (registration files), the
 * agent API (the Providers page) and the registration script.
 *
 * Source: github.com/erc-8004/erc-8004-contracts (README "Ethereum Sepolia",
 * ERC8004SPEC.md, IdentityRegistryUpgradeable.sol), read 2026-10-29.
 *   - The Identity Registry is an ERC-721: each agent is a token (agentId)
 *     whose tokenURI (agentURI) resolves to a registration file.
 *   - register(string agentURI) mints the next agentId to msg.sender and emits
 *     Registered(agentId, agentURI, owner).
 *   - The registration file: type, name, description, services, x402Support,
 *     active, registrations [{agentId, agentRegistry}], supportedTrust.
 *
 * ENS stays the source of truth for prices and payees (D-032). ERC-8004 is
 * identity and discovery only: the firewall never reads it, and no trust
 * model is claimed (`supportedTrust` is left out).
 */

export const ERC8004_SEPOLIA = {
  chainId: 11155111,
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
} as const;

export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';

/** `{namespace}:{chainId}:{identityRegistry}`, the spec's agentRegistry identifier. */
export const agentRegistryId = (chainId: number, registry: string): string =>
  `eip155:${chainId}:${registry}`;

/** The Identity Registry functions this project calls (from IdentityRegistryUpgradeable.sol). */
export const identityRegistryAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setAgentURI',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'newURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const;

/** One agent's on-chain ERC-8004 identity, as recorded in deployments/sepolia-erc8004.json. */
export interface Erc8004Agent {
  readonly agentId: string;
  readonly agentURI: string;
  readonly owner: string;
}

/**
 * deployments/sepolia-erc8004.json (written by `pnpm erc8004:register` from
 * verified chain reads). Like deployments/sepolia.json it holds no timestamps
 * or transaction hashes, so a converged rerun leaves it byte-identical;
 * transaction hashes go to docs/evidence/identity/.
 */
export interface Erc8004Deployment {
  readonly kind: 'erc8004-deployment';
  readonly version: 1;
  readonly chainId: number;
  readonly identityRegistry: string;
  readonly agents: Readonly<Record<string, Erc8004Agent>>;
}

export const ERC8004_DEPLOYMENT_PATH = 'deployments/sepolia-erc8004.json';

/** Stable serialisation: equal deployments give equal bytes (labels sorted). */
export function serializeErc8004Deployment(d: Erc8004Deployment): string {
  const agents = Object.fromEntries(
    Object.entries(d.agents)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, a]) => [k, { agentId: a.agentId, agentURI: a.agentURI, owner: a.owner }]),
  );
  return `${JSON.stringify({ ...d, agents }, null, 2)}\n`;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read the deployment record defensively; null when absent or malformed. Pure. */
export function parseErc8004Deployment(raw: unknown): Erc8004Deployment | null {
  if (!isRecord(raw)) return null;
  const { kind, version, chainId, identityRegistry, agents } = raw;
  if (kind !== 'erc8004-deployment' || version !== 1) return null;
  if (typeof chainId !== 'number' || typeof identityRegistry !== 'string') return null;
  if (!ADDRESS.test(identityRegistry) || !isRecord(agents)) return null;
  const out: Record<string, Erc8004Agent> = {};
  for (const [label, a] of Object.entries(agents)) {
    if (!/^[a-z0-9-]{1,63}$/.test(label) || !isRecord(a)) return null;
    const { agentId, agentURI, owner } = a;
    if (
      typeof agentId !== 'string' ||
      !/^\d{1,78}$/.test(agentId) ||
      typeof agentURI !== 'string' ||
      agentURI.length > 512 ||
      typeof owner !== 'string' ||
      !ADDRESS.test(owner)
    )
      return null;
    out[label] = { agentId, agentURI, owner };
  }
  return { kind: 'erc8004-deployment', version: 1, chainId, identityRegistry, agents: out };
}

export interface RegistrationService {
  readonly name: string;
  readonly endpoint: string;
  readonly version?: string;
}

export interface RegistrationFile {
  readonly type: typeof REGISTRATION_TYPE;
  readonly name: string;
  readonly description: string;
  readonly services: readonly RegistrationService[];
  readonly x402Support: boolean;
  readonly active: boolean;
  readonly registrations: readonly { readonly agentId: number; readonly agentRegistry: string }[];
}

/**
 * The registration file an agentURI resolves to. `registrations` lists the
 * on-chain identity once it exists (an agent registered before its file
 * named its ID still resolves; the file then says so after the next deploy).
 */
export function registrationFile(input: {
  readonly name: string;
  readonly description: string;
  readonly services: readonly RegistrationService[];
  readonly x402Support: boolean;
  readonly agentId: string | null;
  readonly chainId: number;
  readonly identityRegistry: string;
}): RegistrationFile {
  const id = input.agentId === null ? null : Number(input.agentId);
  return {
    type: REGISTRATION_TYPE,
    name: input.name,
    description: input.description,
    services: input.services,
    x402Support: input.x402Support,
    active: true,
    registrations:
      id === null || !Number.isSafeInteger(id)
        ? []
        : [{ agentId: id, agentRegistry: agentRegistryId(input.chainId, input.identityRegistry) }],
  };
}
