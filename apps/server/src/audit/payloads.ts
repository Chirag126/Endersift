/**
 * What the agent posts to its HCS audit topic (plan row 29, D-057). Messages
 * are public and permanent, so they carry proofs, not secrets or the owner's
 * stack: no watchlist (the report's SHA-256 commits to it), no URLs, no keys.
 * Compact JSON with a fixed key order, at most one HCS chunk (1024 bytes). Pure.
 */
import { createHash } from 'node:crypto';

export const AUDIT_MESSAGE_MAX_BYTES = 1024;
export const AUDIT_VERSION = 1;

export interface SettlementFacts {
  readonly agent: string;
  readonly runId: string;
  readonly paymentId: string;
  readonly provider: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly asset: string;
  readonly network: string;
  readonly transactionId: string;
  /** From the Mirror Node verification that made the payment SETTLED. */
  readonly consensusTimestamp: string | null;
}

export interface TaskFacts {
  readonly agent: string;
  readonly runId: string;
  readonly trigger: string;
  readonly status: string;
  readonly verdict: string;
  readonly finishedAt: string | null;
  readonly ensBlock: string | null;
  readonly policyVersion: number | null;
  /** SHA-256 of the brief's markdown, or null when no brief was written. */
  readonly reportSha256: string | null;
  readonly settled: readonly string[];
  readonly refused: number;
  readonly inference: readonly {
    readonly purpose: string;
    readonly requestId: string | null;
    readonly costNeuron: string | null;
  }[];
}

export const sha256Hex = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex');

const bytes = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

export function settlementMessage(f: SettlementFacts): Record<string, unknown> {
  return {
    v: AUDIT_VERSION,
    type: 'settlement',
    agent: f.agent,
    run: f.runId,
    payment: f.paymentId,
    provider: f.provider,
    payTo: f.payTo,
    amount: f.amountAtomic,
    asset: f.asset,
    network: f.network,
    tx: f.transactionId,
    consensus: f.consensusTimestamp,
    verifiedBy: 'mirror-node',
  };
}

/**
 * The task digest. If the lists would push it over one chunk, the transaction
 * and request IDs are replaced by their counts (the message says so) rather
 * than splitting it.
 */
export function taskMessage(f: TaskFacts): Record<string, unknown> {
  const full = {
    v: AUDIT_VERSION,
    type: 'task',
    agent: f.agent,
    run: f.runId,
    trigger: f.trigger,
    status: f.status,
    verdict: f.verdict,
    finishedAt: f.finishedAt,
    ensBlock: f.ensBlock,
    policyVersion: f.policyVersion,
    reportSha256: f.reportSha256,
    settled: f.settled,
    refused: f.refused,
    inference: f.inference.map((c) => ({
      purpose: c.purpose,
      requestId: c.requestId,
      cost: c.costNeuron,
    })),
  };
  if (bytes(full).length <= AUDIT_MESSAGE_MAX_BYTES) return full;
  const { settled, inference, ...rest } = full;
  return {
    ...rest,
    settledCount: settled.length,
    inferenceCount: inference.length,
    truncated: 'IDs omitted to fit one HCS message; see the settlement messages and the API',
  };
}

/** The exact bytes posted, and their SHA-256. Throws if they exceed one chunk. */
export function encodeMessage(message: Record<string, unknown>): {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
} {
  const text = JSON.stringify(message);
  const b = new TextEncoder().encode(text);
  if (b.length > AUDIT_MESSAGE_MAX_BYTES)
    throw new RangeError(`audit message is ${b.length} bytes; at most ${AUDIT_MESSAGE_MAX_BYTES}`);
  return { text, bytes: b, sha256: sha256Hex(b) };
}
