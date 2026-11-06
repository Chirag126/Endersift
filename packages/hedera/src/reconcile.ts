/**
 * What the Mirror Node says about a payment whose outcome we do not know
 * (SUBMITTED or UNKNOWN, D-018, D-042). Pure: the caller fetches every
 * consensus entry for the transaction ID and passes the current time.
 *
 *   SETTLED          an entry with result SUCCESS passes verifyHbarSettlement
 *                    (exact payee credit, exact payer debit, right transaction)
 *   MISMATCH         an entry with SUCCESS exists but does NOT match the
 *                    expected payee or amount: money moved, but not as
 *                    authorised. Never auto-settled, never re-signed: a human
 *                    looks at it.
 *   FAILED           every consensus entry has a non-SUCCESS result (the
 *                    transaction ID is used up), or there is no entry and the
 *                    transaction's validity window has closed, so it can never
 *                    reach consensus any more
 *   PENDING          no entry yet and the window is still open
 *   UNVERIFIABLE     the payment is on another network than this Mirror Node, or
 *                    not in HBAR: nothing is concluded either way
 *
 * Hedera accepts a transaction only until validStart + validDuration (the SDK
 * default is 120 s; the network allows at most 180 s), and the Mirror Node
 * lags consensus by a few seconds. The default
 * `expiryAfterSec` of 300 s (180 + 120 of margin) therefore only declares a
 * payment FAILED when it is impossible for it to settle later.
 */
import type { MirrorTransaction } from './mirror.ts';
import {
  toMirrorTransactionId,
  verifyHbarSettlement,
  type ExpectedSettlement,
  type SettlementCheck,
} from './settlement.ts';

export const DEFAULT_EXPIRY_AFTER_SEC = 300;

export type ReconcileVerdict =
  | {
      readonly outcome: 'SETTLED';
      readonly transaction: MirrorTransaction;
      readonly checks: readonly SettlementCheck[];
    }
  | {
      readonly outcome: 'MISMATCH';
      readonly code: 'SETTLEMENT_MISMATCH';
      readonly transaction: MirrorTransaction;
      readonly checks: readonly SettlementCheck[];
    }
  | {
      readonly outcome: 'FAILED';
      readonly code: string;
      readonly detail: string;
    }
  | { readonly outcome: 'PENDING'; readonly code: 'NOT_YET_VISIBLE'; readonly detail: string }
  /** This verifier cannot judge the payment (wrong network for this Mirror Node, non-HBAR asset). */
  | {
      readonly outcome: 'UNVERIFIABLE';
      readonly code: 'NETWORK_MISMATCH' | 'UNSUPPORTED_ASSET';
      readonly detail: string;
    };

/** Valid-start time of a transaction ID (0.0.N@seconds.nanos), in milliseconds since the epoch. */
export function validStartMs(transactionId: string): number {
  const m = /^0\.0\.\d+@(\d+)\.(\d{9})$/.exec(transactionId);
  if (m === null) throw new Error('transaction ID must look like 0.0.N@seconds.nanos');
  return Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1_000_000);
}

const resultCode = (result: string): string =>
  `TX_RESULT_${result.replace(/[^A-Z0-9_]/gi, '_').toUpperCase()}`.slice(0, 64);

export function reconcileWithMirror(input: {
  readonly expected: ExpectedSettlement;
  /** Every consensus entry the Mirror Node has for the transaction ID ([] if none). */
  readonly entries: readonly MirrorTransaction[];
  readonly now: string;
  readonly expiryAfterSec?: number;
  /** The payment's network and asset, checked against the Mirror Node's network (D-044). */
  readonly payment?: { readonly network: string; readonly asset: string };
  readonly mirrorNetwork?: 'testnet' | 'mainnet';
}): ReconcileVerdict {
  if (input.payment !== undefined) {
    if (
      input.mirrorNetwork !== undefined &&
      input.payment.network !== `hedera:${input.mirrorNetwork}`
    )
      return {
        outcome: 'UNVERIFIABLE',
        code: 'NETWORK_MISMATCH',
        detail: `payment on ${input.payment.network}, Mirror Node is hedera:${input.mirrorNetwork}`,
      };
    if (input.payment.asset !== '0.0.0')
      return {
        outcome: 'UNVERIFIABLE',
        code: 'UNSUPPORTED_ASSET',
        detail: `asset ${input.payment.asset}: only HBAR (0.0.0) settlements are verified so far`,
      };
  }
  const wantId = toMirrorTransactionId(input.expected.transactionId);
  const entries = input.entries.filter((e) => e.transactionId === wantId);

  const successes = entries.filter((e) => e.result === 'SUCCESS');
  for (const tx of successes) {
    const verdict = verifyHbarSettlement(tx, input.expected);
    if (verdict.ok) return { outcome: 'SETTLED', transaction: tx, checks: verdict.checks };
  }
  const first = successes[0];
  if (first !== undefined) {
    return {
      outcome: 'MISMATCH',
      code: 'SETTLEMENT_MISMATCH',
      transaction: first,
      checks: verifyHbarSettlement(first, input.expected).checks,
    };
  }

  const failed = entries[0];
  if (failed !== undefined) {
    return {
      outcome: 'FAILED',
      code: resultCode(failed.result),
      detail: `reached consensus with ${entries.map((e) => e.result).join(', ')}`,
    };
  }

  const start = validStartMs(input.expected.transactionId);
  const expiry = start + (input.expiryAfterSec ?? DEFAULT_EXPIRY_AFTER_SEC) * 1000;
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error('now must be an ISO timestamp');
  if (now > expiry) {
    return {
      outcome: 'FAILED',
      code: 'TX_EXPIRED_NOT_FOUND',
      detail: `no consensus entry, and the validity window closed at ${new Date(expiry).toISOString()}`,
    };
  }
  return {
    outcome: 'PENDING',
    code: 'NOT_YET_VISIBLE',
    detail: `no consensus entry yet; it could still appear until ${new Date(expiry).toISOString()}`,
  };
}
