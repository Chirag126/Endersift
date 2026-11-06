/**
 * Router account reads used by the inference ledger: usage-history entries
 * (what the dashboard's Usage page lists) and balance snapshots.
 *
 * Field names are the ones seen live on 0G testnet (2026-10-27,
 * docs/evidence/zg/structured-20261027T083646Z.json): request_id,
 * provider_address, model_id, canonical_id, input_tokens, output_tokens,
 * cost, credit_used, deposit_used, created_at. The history schema is not
 * documented field by field, so an entry missing a required field is skipped
 * (reported as unparsed), never guessed.
 */
import { isRecord } from './http.ts';
import { parseNeuron } from './units.ts';

export interface UsageEntry {
  readonly requestId: string;
  readonly provider: string | null;
  /** canonical_id when present (lower-case catalog ID), else model_id. */
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: bigint;
  readonly creditUsed: bigint;
  readonly depositUsed: bigint;
  readonly createdAt: string;
  readonly raw: Record<string, unknown>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

export function parseUsageEntry(entry: unknown): UsageEntry | null {
  if (!isRecord(entry)) return null;
  const requestId = str(entry['request_id']);
  const createdAt = str(entry['created_at']);
  const inputTokens = count(entry['input_tokens']);
  const outputTokens = count(entry['output_tokens']);
  if (requestId === null || createdAt === null || Number.isNaN(Date.parse(createdAt))) return null;
  if (inputTokens === null || outputTokens === null) return null;
  try {
    return {
      requestId,
      provider: str(entry['provider_address']),
      model: str(entry['canonical_id']) ?? str(entry['model_id']),
      inputTokens,
      outputTokens,
      cost: parseNeuron(entry['cost'], 'cost').neuron,
      creditUsed: parseNeuron(entry['credit_used'], 'credit_used').neuron,
      depositUsed: parseNeuron(entry['deposit_used'], 'deposit_used').neuron,
      createdAt: new Date(createdAt).toISOString(),
      raw: entry,
    };
  } catch {
    return null;
  }
}

/** The history body is an array, or an object with a `data` array (both seen in the wild). */
export function parseUsageHistory(body: unknown): {
  readonly entries: UsageEntry[];
  readonly unparsed: number;
} {
  const list: unknown[] = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body['data'])
      ? body['data']
      : [];
  const entries: UsageEntry[] = [];
  let unparsed = 0;
  for (const item of list) {
    const e = parseUsageEntry(item);
    if (e === null) unparsed += 1;
    else entries.push(e);
  }
  return { entries, unparsed };
}

export interface BalanceFields {
  readonly address: string;
  readonly depositBalance: bigint | null;
  readonly creditBalance: bigint | null;
  readonly pendingCharge: bigint | null;
  readonly totalBalance: bigint | null;
  readonly balance: bigint | null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Every /account/balance figure, null where the Router omitted it. Throws without an address. */
export function parseBalanceFields(body: unknown): BalanceFields {
  if (!isRecord(body)) throw new Error('balance response is not an object');
  const address = body['address'];
  if (typeof address !== 'string' || !ADDRESS.test(address))
    throw new Error('balance.address is not an address');
  const field = (name: string): bigint | null =>
    body[name] === undefined || body[name] === null ? null : parseNeuron(body[name], name).neuron;
  return {
    address,
    depositBalance: field('deposit_balance'),
    creditBalance: field('credit_balance'),
    pendingCharge: field('pending_charge'),
    totalBalance: field('total_balance'),
    balance: field('balance'),
  };
}
