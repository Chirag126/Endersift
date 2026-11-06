/**
 * ENSv2 Sepolia deployment (the 2026-10-01 redeploy).
 *
 * Source: docs.ens.domains/learn/deployments ("Sepolia (ENSv2)" table), read
 * 2026-10-26, cross-checked with ensdomains/contracts-v2 PR #460 ("Key
 * addresses") and ensdomains/ensjs PR #389. If ENS redeploys again, update
 * here only; scripts read nothing else.
 */
import type { Address } from 'viem';

export const SEPOLIA_CHAIN_ID = 11155111;

export const ENSV2_SEPOLIA = {
  ethRegistrar: '0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3',
  ethRegistry: '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4',
  rootRegistry: '0xb458d6a3a77919449d03e7a6903c26827c1ec43f',
  /** Upgradable Universal Resolver proxy (same address on mainnet and Sepolia). */
  universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
  universalResolverV2: '0x24e1d8e068620b647ca097f961a61055f4f42d72',
  permissionedResolverImpl: '0x115eb53f0c60696633855f90b138178fb40b2b2c',
  verifiableFactory: '0xda70306c98e97ece36f997a21368e53298572991',
  userRegistryImpl: '0x9bd8a88719068d09ecee662f36c0e3856708366a',
  standardRentPriceOracle: '0x8196665d4ca7488b6474a9ec8e7d2719fb42263a',
  mockUsdc: '0x240b0316df57887dbbe58b586508b19e633a14aa',
  mockDai: '0xf6fac8a58a0be13b9197f27c41b73162fe32572b',
} as const satisfies Record<string, Address>;

/** One year in seconds: the registration length used by this project. */
export const REGISTRATION_SECONDS = 31_536_000n;

/** No referrer. */
export const ZERO_REFERRER = `0x${'0'.repeat(64)}` as const;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/**
 * PermissionedResolver role bits (docs.ens.domains/ensv2/permissioned-resolver).
 * The admin role for each is `role << 128`.
 */
export const RESOLVER_ROLES = {
  SET_ADDRESS: 1n << 0n,
  SET_TEXT: 1n << 4n,
  SET_CONTENTHASH: 1n << 8n,
  SET_ABI: 1n << 12n,
  SET_INTERFACE: 1n << 16n,
  SET_NAME: 1n << 20n,
  SET_DATA: 1n << 24n,
  LINK: 1n << 28n,
  CAN_NAME: 1n << 120n,
  UPGRADE: 1n << 124n,
} as const;

/** Every role and its admin counterpart, granted to the resolver's owner at deploy. */
export const ALL_RESOLVER_ROLES: bigint = Object.values(RESOLVER_ROLES).reduce(
  (acc, role) => acc | role | (role << 128n),
  0n,
);

export const sepoliaEtherscanTx = (hash: string): string =>
  `https://sepolia.etherscan.io/tx/${hash}`;
export const sepoliaEtherscanAddress = (address: string): string =>
  `https://sepolia.etherscan.io/address/${address}`;

/**
 * PermissionedRegistry role bits, verbatim from RegistryRolesLib.sol at the
 * deployed commit (ensdomains/contracts-v2 PR #460 head, 2026-10-01). Admin
 * role = role << 128. ROLE_CAN_TRANSFER_ADMIN exists only as an admin role.
 */
export const REGISTRY_ROLES = {
  REGISTRAR: 1n << 0n,
  REGISTER_RESERVED: 1n << 4n,
  SET_PARENT: 1n << 8n,
  UNREGISTER: 1n << 12n,
  RENEW: 1n << 16n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  SET_URI: 1n << 36n,
  UPGRADE: 1n << 124n,
} as const;
export const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;

const withAdmin = (roles: readonly bigint[]): bigint =>
  roles.reduce((acc, r) => acc | r | (r << 128n), 0n);

/** Root roles for the owner of a subregistry we deploy: every grantable role and its admin. */
export const USER_REGISTRY_ROOT_ROLES: bigint =
  withAdmin(Object.values(REGISTRY_ROLES)) | ROLE_CAN_TRANSFER_ADMIN;

/**
 * Token roles for a subname's owner: the same set the ETHRegistrar grants a
 * .eth registrant (REGISTRATION_ROLE_BITMAP in ETHRegistrar.sol): change the
 * subregistry or resolver, administer those roles, and transfer.
 */
export const SUBNAME_TOKEN_ROLES: bigint =
  withAdmin([REGISTRY_ROLES.SET_SUBREGISTRY, REGISTRY_ROLES.SET_RESOLVER]) |
  ROLE_CAN_TRANSFER_ADMIN;
