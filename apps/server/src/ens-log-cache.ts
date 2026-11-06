/**
 * The ENS registration-log cache on disk (D-059): the logs a discovery has
 * already scanned, so the next one reads only newer blocks. The contents are
 * public chain history (labels, block numbers, transaction hashes), nothing
 * secret. The file is read as untrusted input: anything malformed is ignored
 * and the scan starts over. Records and registration state are never cached;
 * discovery reads them live at its pinned block.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CachedLogs, LogCache, RegistrationLog } from '@agent-economy/ens';

const BLOCK = /^\d{1,12}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const LABEL = /^[a-z0-9-]{1,63}$/;

/** Parse a cache file's JSON; null when anything is off. Pure. */
export function parseCachedLogs(text: string): CachedLogs | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const sub = str('subregistry');
  const from = str('fromBlock');
  const to = str('scannedTo');
  const refused = r['refusedRange'];
  if (
    sub === null ||
    !ADDRESS.test(sub) ||
    from === null ||
    !BLOCK.test(from) ||
    to === null ||
    !BLOCK.test(to)
  )
    return null;
  if (!Array.isArray(r['logs']) || r['logs'].length > 10_000) return null;
  const logs: RegistrationLog[] = [];
  for (const l of r['logs'] as unknown[]) {
    if (typeof l !== 'object' || l === null) return null;
    const e = l as Record<string, unknown>;
    if (
      typeof e['label'] !== 'string' ||
      !LABEL.test(e['label']) ||
      typeof e['blockNumber'] !== 'string' ||
      !BLOCK.test(e['blockNumber']) ||
      typeof e['transactionHash'] !== 'string' ||
      !HASH.test(e['transactionHash']) ||
      typeof e['logIndex'] !== 'number' ||
      !Number.isInteger(e['logIndex']) ||
      e['logIndex'] < 0
    )
      return null;
    logs.push({
      label: e['label'],
      blockNumber: BigInt(e['blockNumber']),
      transactionHash: e['transactionHash'],
      logIndex: e['logIndex'],
    });
  }
  if (BigInt(to) < BigInt(from)) return null;
  return {
    subregistry: sub,
    fromBlock: BigInt(from),
    scannedTo: BigInt(to),
    logs,
    refusedRange: typeof refused === 'string' && BLOCK.test(refused) ? BigInt(refused) : null,
  };
}

export function serializeCachedLogs(e: CachedLogs): string {
  return JSON.stringify({
    subregistry: e.subregistry,
    fromBlock: e.fromBlock.toString(),
    scannedTo: e.scannedTo.toString(),
    refusedRange:
      e.refusedRange === null || e.refusedRange === undefined ? null : e.refusedRange.toString(),
    logs: e.logs.map((l) => ({
      label: l.label,
      blockNumber: l.blockNumber.toString(),
      transactionHash: l.transactionHash,
      logIndex: l.logIndex,
    })),
  });
}

/** A cache in one JSON file, written atomically (temp file + rename). */
export function fileLogCache(path: string): LogCache {
  return {
    load: () => {
      try {
        return parseCachedLogs(readFileSync(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save: (entry) => {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, serializeCachedLogs(entry), 'utf8');
        renameSync(tmp, path);
      } catch {
        // a cache that cannot be written only costs a full scan next time
      }
    },
  };
}
