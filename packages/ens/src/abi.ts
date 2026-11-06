/**
 * Minimal ABIs, written from the signatures documented at
 * docs.ens.domains/ensv2/{eth-registrar,permissioned-resolver,verifiable-factory}.
 * Only the functions this project calls are listed.
 */
import { parseAbi } from 'viem';

export const ethRegistrarAbi = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label, uint64 duration, address paymentToken) view returns (uint256 base, uint256 premium)',
  'function makeCommitment(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, bytes32 referrer) pure returns (bytes32)',
  'function commit(bytes32 commitment)',
  'function commitmentAt(bytes32 commitment) view returns (uint64)',
  'function register(string label, address owner, bytes32 secret, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 referrer) returns (uint256 tokenId)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
  'function MAX_COMMITMENT_AGE() view returns (uint64)',
  'function rentPriceOracle() view returns (address)',
]);

export const rentPriceOracleAbi = parseAbi([
  'function isPaymentToken(address token) view returns (bool)',
]);

/** MockUSDC on Sepolia: standard ERC-20 plus an open mint (used only on testnet). */
export const mockErc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function mint(address to, uint256 amount)',
]);

export const verifiableFactoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address proxy)',
  'function predictProxyAddress(address deployer, uint256 salt) view returns (address proxy)',
  'event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)',
]);

export const permissionedResolverAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)',
  'function setText(bytes name, string key, string value)',
  'function multicall(bytes[] calls) returns (bytes[] results)',
  'function grantSetterRoles(bytes setter, address account) returns (bool)',
  'function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)',
  'function revokeRootRoles(uint256 roleBitmap, address account) returns (bool)',
  'function roles(uint256 resource, address account) view returns (uint256)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  // record linking and the default record (D-066), PermissionedResolver.sol at the deployed commit
  'function linkToNode(bytes sourceName, bytes32 targetNode)',
  'function getRecordId(bytes32 node) view returns (uint256)',
  'error InvalidRecord()',
  // EnhancedAccessControl errors (IEnhancedAccessControl.sol at the deployed commit), for decoding reverts.
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACRootResourceNotAllowed()',
]);

/** ITextResolver.text, used only to encode the inner call of resolver.resolve(name, data). */
export const textResolverAbi = parseAbi([
  'function text(bytes32 node, string key) view returns (string)',
]);

/**
 * PermissionedRegistry (the ETHRegistry and every UserRegistry), from
 * IRegistry / IStandardRegistry / UserRegistry at the deployed commit.
 * `anyId` accepts a labelhash (uint256(keccak256(label))), token ID or resource.
 */
export const permissionedRegistryAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256 tokenId)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
  'function setParent(address parent, string label)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getParent() view returns (address parent, string label)',
  'function getExpiry(uint256 anyId) view returns (uint64)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function getStatus(uint256 anyId) view returns (uint8)',
  'function unregister(uint256 anyId)',
  'event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)',
  // transfers and ownership (D-066), PermissionedRegistry.sol / IPermissionedRegistry.sol at the deployed commit
  'function unsafeTransfer(address to, uint256 tokenId, bytes data)',
  'function getTokenId(uint256 anyId) view returns (uint256)',
  'function getOwner(uint256 anyId) view returns (address)',
  'error TransferDisallowed(uint256 tokenId, address from)',
  'error TransferUnsafeUntilRegistryIsEmancipated()',
]);
