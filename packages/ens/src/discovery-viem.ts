/**
 * viem implementation of DiscoveryChain (Sepolia ENSv2). Every read takes the
 * pinned block number. Resolution helpers return null when a name or record
 * does not resolve, but transport failures (HTTP errors, timeouts) are
 * rethrown: an RPC outage must never look like "provider has no records".
 */
import {
  BaseError,
  HttpRequestError,
  TimeoutError,
  getAbiItem,
  type PublicClient,
  type Transport,
  type Chain,
} from 'viem';
import { ENSV2_SEPOLIA } from './constants.ts';
import { permissionedRegistryAbi } from './abi.ts';
import { labelId } from './names.ts';
import type { DiscoveryChain, RegistrationLog } from './discovery.ts';

const labelRegistered = getAbiItem({ abi: permissionedRegistryAbi, name: 'LabelRegistered' });

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null;
}

async function orNull<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (isTransportFailure(error)) throw error;
    return null;
  }
}

export function viemDiscoveryChain(
  client: PublicClient<Transport, Chain>,
  universalResolverAddress: `0x${string}` = ENSV2_SEPOLIA.universalResolver,
  ethRegistry: `0x${string}` = ENSV2_SEPOLIA.ethRegistry,
): DiscoveryChain {
  return {
    async head() {
      const b = await client.getBlock({ blockTag: 'latest' });
      if (b.number === null || b.hash === null)
        throw new Error('latest block has no number or hash');
      return { number: b.number, hash: b.hash, timestamp: b.timestamp };
    },
    subregistryOf: (parentLabel, block) =>
      client.readContract({
        address: ethRegistry,
        abi: permissionedRegistryAbi,
        functionName: 'getSubregistry',
        args: [parentLabel],
        blockNumber: block,
      }),
    async hasCode(address, block) {
      const code = await client.getCode({ address: address as `0x${string}`, blockNumber: block });
      return code !== undefined && code !== '0x';
    },
    async registrationLogs(registry, fromBlock, toBlock) {
      const logs = await client.getLogs({
        address: registry as `0x${string}`,
        event: labelRegistered,
        fromBlock,
        toBlock,
        strict: true,
      });
      const out: RegistrationLog[] = [];
      for (const l of logs) {
        if (l.blockNumber === null || l.transactionHash === null || l.logIndex === null) continue;
        out.push({
          label: l.args.label,
          blockNumber: l.blockNumber,
          transactionHash: l.transactionHash,
          logIndex: l.logIndex,
        });
      }
      return out;
    },
    async statusOf(registry, label, block) {
      const status = await client.readContract({
        address: registry as `0x${string}`,
        abi: permissionedRegistryAbi,
        functionName: 'getStatus',
        args: [labelId(label)],
        blockNumber: block,
      });
      return Number(status);
    },
    registryResolverOf: (registry, label, block) =>
      client.readContract({
        address: registry as `0x${string}`,
        abi: permissionedRegistryAbi,
        functionName: 'getResolver',
        args: [label],
        blockNumber: block,
      }),
    resolverOf: (name, block) =>
      orNull(() => client.getEnsResolver({ name, universalResolverAddress, blockNumber: block })),
    textOf: (name, key, block) =>
      orNull(() => client.getEnsText({ name, key, universalResolverAddress, blockNumber: block })),
  };
}
