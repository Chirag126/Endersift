/**
 * Balance snapshot job (plan row 18): reads the Router's /account/balance
 * and stores every figure as a `zg_balance_snapshots` row.
 *
 * What a snapshot is evidence of (D-039, D-040): the Router float, credits
 * and the charge still pending collection from the Payment Layer. It is not
 * the whole deposit, so snapshots are never used to allow or refuse a call;
 * the per-call and daily caps do that. They make the money trail visible
 * next to the ledger rows (float drained → pending charge → refilled).
 *
 * The job never overlaps itself and never throws out of its timer: a failed
 * read is reported through `onError` and the next tick tries again.
 */
import { randomUUID } from 'node:crypto';
import type { ZgBalanceSnapshot } from '@agent-economy/core/domain';
import { parseBalanceFields, type ZgRouterClient } from '@agent-economy/zg';
import type { InferenceLedger } from './inference-ledger.ts';

export interface SnapshotDeps {
  readonly client: Pick<ZgRouterClient, 'getBalanceRaw'>;
  readonly ledger: Pick<InferenceLedger, 'recordBalanceSnapshot'>;
  readonly network: ZgBalanceSnapshot['network'];
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export async function takeBalanceSnapshot(
  deps: SnapshotDeps,
  trigger: ZgBalanceSnapshot['trigger'],
): Promise<ZgBalanceSnapshot> {
  const fields = parseBalanceFields(await deps.client.getBalanceRaw());
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  return deps.ledger.recordBalanceSnapshot({
    id: (deps.newId ?? randomUUID)(),
    network: deps.network,
    address: fields.address,
    depositBalanceNeuron: s(fields.depositBalance),
    creditBalanceNeuron: s(fields.creditBalance),
    pendingChargeNeuron: s(fields.pendingCharge),
    totalBalanceNeuron: s(fields.totalBalance),
    balanceNeuron: s(fields.balance),
    trigger,
    takenAt: (deps.now ?? (() => new Date()))().toISOString(),
  });
}

export interface SnapshotJob {
  /** Resolves once the in-flight snapshot (if any) has finished. */
  stop(): Promise<void>;
}

export function startBalanceSnapshotJob(
  deps: SnapshotDeps & {
    readonly intervalMs: number;
    readonly onSnapshot?: (s: ZgBalanceSnapshot) => void;
    readonly onError?: (error: unknown) => void;
    /** Take one snapshot immediately (default true). */
    readonly immediate?: boolean;
  },
): SnapshotJob {
  if (!Number.isInteger(deps.intervalMs) || deps.intervalMs < 1000)
    throw new Error('intervalMs must be an integer >= 1000');
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running !== null) return; // never overlap
    running = takeBalanceSnapshot(deps, 'job')
      .then((s) => deps.onSnapshot?.(s))
      .catch((error: unknown) => deps.onError?.(error))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, deps.intervalMs);
  if (deps.immediate ?? true) tick();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (running !== null) await running;
    },
  };
}
