/**
 * Provider discovery (plan row 14): our subregistry's LabelRegistered logs →
 * labels → registry status → Universal Resolver → validated providers, all
 * pinned to one block so a snapshot is internally consistent.
 *
 * Nothing about the providers is hard-coded: the only input is the parent
 * name. A new subname with valid records appears on the next run; an
 * unregistered, expired, paused or malformed one is reported under `skipped`
 * with a reason, never silently dropped.
 *
 * Chain access goes through `DiscoveryChain` (implemented with viem in
 * discovery-viem.ts), so this module is testable without a network.
 * Everything read from chain is untrusted: labels are re-validated, the
 * Universal Resolver's resolver must equal our subregistry's, and records go
 * through the strict parser and the zod domain schema.
 */
import {
  parseAgentRecords,
  AGENT_RECORD_READ_KEYS,
  type AgentRecords,
  type X402Network,
} from './records.ts';
import { toProviderAgent } from './provider.ts';
import type { ProviderAgent } from '@agent-economy/core/domain';

/** PermissionedRegistry.Status (IPermissionedRegistry.sol). */
export const REGISTRY_STATUS = { AVAILABLE: 0, RESERVED: 1, REGISTERED: 2 } as const;

export interface RegistrationLog {
  readonly label: string;
  readonly blockNumber: bigint;
  readonly transactionHash: string;
  readonly logIndex: number;
}

/** Scanned registration logs of one subregistry, kept between discoveries (D-059). */
export interface CachedLogs {
  readonly subregistry: string;
  /** Every log in [fromBlock, scannedTo] is in `logs`. */
  readonly fromBlock: bigint;
  readonly scannedTo: bigint;
  readonly logs: readonly RegistrationLog[];
  /** The smallest getLogs window this RPC refused, so the next scan starts below it. */
  readonly refusedRange?: bigint | null;
}

export interface LogCache {
  load(): CachedLogs | null;
  save(entry: CachedLogs): void;
}

/** Blocks re-read below the cached end, in case the chain reorganised. */
export const REORG_MARGIN = 64n;

/** An RPC answer meaning "too many requests", not "range too large". */
export function isRateLimitError(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return /compute units per second|rate.?limit|too many requests|status: 429|\b429\b|-32005/i.test(
    text,
  );
}

export interface DiscoveryChain {
  /** The block every read is pinned to. */
  head(): Promise<{ readonly number: bigint; readonly hash: string; readonly timestamp: bigint }>;
  /** ETHRegistry.getSubregistry(parentLabel) at `block`. */
  subregistryOf(parentLabel: string, block: bigint): Promise<string>;
  hasCode(address: string, block: bigint): Promise<boolean>;
  /** LabelRegistered logs of `registry` in [fromBlock, toBlock] (inclusive). May throw on range limits. */
  registrationLogs(
    registry: string,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<RegistrationLog[]>;
  /** registry.getStatus(labelId(label)) at `block`. */
  statusOf(registry: string, label: string, block: bigint): Promise<number>;
  /** registry.getResolver(label) at `block`. */
  registryResolverOf(registry: string, label: string, block: bigint): Promise<string>;
  /** Universal Resolver: the resolver of `name` at `block`, or null when none. */
  resolverOf(name: string, block: bigint): Promise<string | null>;
  /** Universal Resolver: text(name, key) at `block`; null when unset or unresolvable. */
  textOf(name: string, key: string, block: bigint): Promise<string | null>;
}

export interface DiscoveryOptions {
  readonly parentName: string;
  readonly parentLabel: string;
  readonly chain: 'sepolia' | 'mainnet';
  /** Required, so every caller decides: accept loopback http endpoints (local development, D-035). */
  readonly allowLocalHttp: boolean;
  readonly expectedNetwork: X402Network;
  /** Start of the log scan; when absent, the subregistry's deployment block is searched. */
  readonly fromBlock?: bigint;
  /** First getLogs window; halved on errors down to `minLogRange`. */
  readonly logRange?: bigint;
  readonly minLogRange?: bigint;
  /**
   * Registration logs already scanned (D-059). Logs are chain history, so a
   * cached range is not read again: only blocks after it (minus a reorg
   * margin) are. Records and registration state are still read live, at the
   * pinned block, for every label.
   */
  readonly logCache?: LogCache;
  /** Pause between getLogs calls, to stay under an RPC plan's request rate. */
  readonly minLogIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** ISO timestamp recorded as each provider's discoveredAt (defaults to the block time). */
  readonly discoveredAt?: string;
}

export type SkipCode =
  | 'INVALID_LABEL'
  | 'NOT_REGISTERED'
  | 'NO_RESOLVER'
  | 'RESOLUTION_PATH_MISMATCH'
  | 'INVALID_RECORDS'
  | 'NOT_PURCHASABLE';

export interface DiscoveredProvider {
  readonly label: string;
  readonly name: string;
  readonly resolver: string;
  readonly registeredAtBlock: bigint;
  readonly registrationTx: string;
  readonly records: AgentRecords;
  readonly provider: ProviderAgent;
}

export interface SkippedLabel {
  readonly label: string;
  readonly code: SkipCode;
  readonly reason: string;
  readonly registeredAtBlock: bigint;
}

export interface DiscoverySnapshot {
  readonly parent: string;
  readonly subregistry: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly blockTimestamp: bigint;
  readonly fromBlock: bigint;
  readonly logsScanned: number;
  readonly labelsSeen: number;
  readonly allowLocalHttp: boolean;
  readonly providers: readonly DiscoveredProvider[];
  readonly skipped: readonly SkippedLabel[];
}

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** First block at which `address` has code (binary search; needs archive state). */
export async function findDeploymentBlock(
  chain: Pick<DiscoveryChain, 'hasCode'>,
  address: string,
  head: bigint,
): Promise<bigint> {
  if (!(await chain.hasCode(address, head))) {
    throw new DiscoveryError(`no contract at ${address} at block ${head}`);
  }
  let lo = 0n;
  let hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (await chain.hasCode(address, mid)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

export interface ScanOptions {
  /** Called after each window with everything found so far, the last block covered and the refused window. */
  readonly onProgress?: (
    logs: readonly RegistrationLog[],
    scannedTo: bigint,
    refusedRange: bigint | null,
  ) => void;
  /** A window size this RPC is already known to refuse (from an earlier scan). */
  readonly refusedRange?: bigint | null;
  readonly minIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * All LabelRegistered logs in [from, to], in windows that adapt to the RPC's
 * range limit (D-059):
 *   - a window the RPC refuses is halved, down to `minRange`;
 *   - after a success the window grows again, but never back to a size that
 *     was refused (an RPC limited to 10 blocks would otherwise fail every
 *     other call);
 *   - a rate-limit answer is not a range problem: it is thrown at once, with
 *     the progress so far already reported, so a retry resumes there.
 */
export async function scanRegistrationLogs(
  chain: Pick<DiscoveryChain, 'registrationLogs'>,
  registry: string,
  from: bigint,
  to: bigint,
  initialRange = 50_000n,
  minRange = 10n,
  o: ScanOptions = {},
): Promise<RegistrationLog[]> {
  const out: RegistrationLog[] = [];
  /** The smallest window the RPC refused; windows stay below it. */
  let refused: bigint | null = o.refusedRange ?? null;
  let range = initialRange;
  while (refused !== null && range >= refused && range > minRange) {
    range = range / 2n < minRange ? minRange : range / 2n;
  }
  let start = from;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let first = true;
  while (start <= to) {
    if (!first && (o.minIntervalMs ?? 0) > 0) await sleep(o.minIntervalMs ?? 0);
    first = false;
    const end = start + range - 1n < to ? start + range - 1n : to;
    try {
      out.push(...(await chain.registrationLogs(registry, start, end)));
      o.onProgress?.(out, end, refused);
      start = end + 1n;
      const grown = range * 2n;
      if (range < initialRange && (refused === null || grown < refused)) range = grown;
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      if (range <= minRange) throw error;
      refused = refused === null || range < refused ? range : refused;
      range = range / 2n < minRange ? minRange : range / 2n;
    }
  }
  return out.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
}

/** Latest registration per label (re-registrations replace earlier ones). */
export function latestRegistrations(
  logs: readonly RegistrationLog[],
): Map<string, RegistrationLog> {
  const out = new Map<string, RegistrationLog>();
  for (const log of logs) out.set(log.label, log); // logs are sorted ascending
  return out;
}

async function examine(
  chain: DiscoveryChain,
  opts: DiscoveryOptions,
  registry: string,
  log: RegistrationLog,
  block: bigint,
  discoveredAt: string,
): Promise<DiscoveredProvider | SkippedLabel> {
  const label = log.label;
  const skip = (code: SkipCode, reason: string): SkippedLabel => ({
    label,
    code,
    reason,
    registeredAtBlock: log.blockNumber,
  });
  if (!LABEL.test(label))
    return skip('INVALID_LABEL', 'the label is not a lowercase DNS-style label');
  const name = `${label}.${opts.parentName}`;
  const status = await chain.statusOf(registry, label, block);
  if (status !== REGISTRY_STATUS.REGISTERED) {
    return skip(
      'NOT_REGISTERED',
      status === REGISTRY_STATUS.RESERVED ? 'reserved, not registered' : 'unregistered or expired',
    );
  }
  const [registryResolver, resolver] = await Promise.all([
    chain.registryResolverOf(registry, label, block),
    chain.resolverOf(name, block),
  ]);
  if (same(registryResolver, ZERO) || resolver === null)
    return skip('NO_RESOLVER', 'no resolver is set');
  if (!same(registryResolver, resolver)) {
    return skip(
      'RESOLUTION_PATH_MISMATCH',
      'the Universal Resolver does not resolve this name through our subregistry',
    );
  }
  const text: Record<string, string | null> = {};
  await Promise.all(
    AGENT_RECORD_READ_KEYS.map(async (key) => {
      text[key] = await chain.textOf(name, key, block);
    }),
  );
  const parsed = parseAgentRecords(text, {
    allowLocalHttp: opts.allowLocalHttp,
    expectedNetwork: opts.expectedNetwork,
  });
  if (!parsed.ok) {
    return skip('INVALID_RECORDS', parsed.problems.map((p) => `${p.key}:${p.code}`).join(', '));
  }
  const result = toProviderAgent({
    ensName: name,
    label,
    chain: opts.chain,
    resolver,
    records: parsed.records,
    discoveredAt,
    allowLocalHttp: opts.allowLocalHttp,
  });
  if (!result.ok) return skip('NOT_PURCHASABLE', result.reason);
  return {
    label,
    name,
    resolver,
    registeredAtBlock: log.blockNumber,
    registrationTx: log.transactionHash,
    records: parsed.records,
    provider: result.provider,
  };
}

export async function discoverProviders(
  chain: DiscoveryChain,
  opts: DiscoveryOptions,
): Promise<DiscoverySnapshot> {
  const head = await chain.head();
  const block = head.number;
  const registry = await chain.subregistryOf(opts.parentLabel, block);
  if (same(registry, ZERO)) {
    throw new DiscoveryError(`${opts.parentName} has no subregistry at block ${block}`);
  }
  const fromBlock = opts.fromBlock ?? (await findDeploymentBlock(chain, registry, block));

  // reuse the logs already scanned for this subregistry (D-059); read only what is newer
  const cached = opts.logCache?.load() ?? null;
  const usable =
    cached !== null &&
    same(cached.subregistry, registry) &&
    cached.fromBlock <= fromBlock &&
    cached.scannedTo >= fromBlock &&
    cached.scannedTo <= block;
  const known = usable ? cached.logs.filter((l) => l.blockNumber >= fromBlock) : [];
  const resumeAt = usable
    ? (() => {
        const r = cached.scannedTo - REORG_MARGIN + 1n;
        return r > fromBlock ? r : fromBlock;
      })()
    : fromBlock;
  const keep = known.filter((l) => l.blockNumber < resumeAt);
  const merge = (fresh: readonly RegistrationLog[]): RegistrationLog[] => {
    const byId = new Map<string, RegistrationLog>();
    for (const l of [...keep, ...fresh]) byId.set(`${l.transactionHash}:${l.logIndex}`, l);
    return [...byId.values()].sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    );
  };
  let refusedRange: bigint | null = usable ? (cached.refusedRange ?? null) : null;
  const saveProgress = (
    fresh: readonly RegistrationLog[],
    scannedTo: bigint,
    refused: bigint | null = refusedRange,
  ) => {
    refusedRange = refused;
    opts.logCache?.save({
      subregistry: registry,
      fromBlock,
      scannedTo,
      logs: merge(fresh),
      refusedRange: refused,
    });
  };
  const fresh = await scanRegistrationLogs(
    chain,
    registry,
    resumeAt,
    block,
    opts.logRange ?? 50_000n,
    opts.minLogRange ?? 10n,
    {
      onProgress: saveProgress,
      refusedRange,
      ...(opts.minLogIntervalMs === undefined ? {} : { minIntervalMs: opts.minLogIntervalMs }),
      ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
    },
  );
  const logs = merge(fresh);
  saveProgress(fresh, block);
  const latest = latestRegistrations(logs);
  const discoveredAt = opts.discoveredAt ?? new Date(Number(head.timestamp) * 1000).toISOString();
  const results = await Promise.all(
    [...latest.values()].map((log) => examine(chain, opts, registry, log, block, discoveredAt)),
  );
  const byLabel = <T extends { label: string }>(a: T, b: T) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  return {
    parent: opts.parentName,
    subregistry: registry,
    blockNumber: block,
    blockHash: head.hash,
    blockTimestamp: head.timestamp,
    fromBlock,
    logsScanned: logs.length,
    labelsSeen: latest.size,
    allowLocalHttp: opts.allowLocalHttp,
    providers: results.filter((r): r is DiscoveredProvider => 'provider' in r).sort(byLabel),
    skipped: results.filter((r): r is SkippedLabel => 'code' in r).sort(byLabel),
  };
}
