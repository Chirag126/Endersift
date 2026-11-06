/**
 * The viem surface the repo scripts use, re-exported from the package that
 * declares the dependency. pnpm's strict layout links viem only into
 * packages/ens, so root-level scripts import it through here (same pattern as
 * the Hiero SDK via packages/hedera, D-016): one declared, pinned version.
 */
export {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseEventLogs,
} from 'viem';
export type { Address, Hash } from 'viem';
export { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
export { sepolia } from 'viem/chains';
export { namehash, normalize } from 'viem/ens';
