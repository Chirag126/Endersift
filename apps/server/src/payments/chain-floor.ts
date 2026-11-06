/**
 * Today's x402 spend that this database does not know about, read from the
 * Hedera Mirror Node (D-062).
 *
 * The firewall's daily budget is counted from the payments table. On a host
 * that wipes the database on restart (Render free plan), or when another copy
 * of the agent pays from the same account, that table alone undercounts and
 * the day's budget could be spent twice. The chain does not reset: before any
 * 0G call or payment, each run reads the payer's transfers for the UTC day and
 * adds every x402 payment whose transaction ID is not in this database.
 *
 * What counts as an x402 payment: a successful CRYPTOTRANSFER that debits the
 * payer while ANOTHER account paid the transaction fee. That is how the
 * Hedera "exact" scheme settles (the facilitator is the fee payer). The payer's
 * own transactions (manual transfers, HCS messages, account updates) are not
 * agent purchases and are not counted.
 *
 * Fail closed: if the Mirror Node cannot be read, the run fails before any 0G
 * call or payment (the settlement verifier needs the Mirror Node anyway).
 */
import { toMirrorTransactionId, type MirrorTransaction } from '@agent-economy/hedera';

/** The fee payer of a Mirror Node transaction ID (0.0.N-seconds-nanos). */
const feePayerOf = (mirrorTransactionId: string): string => mirrorTransactionId.split('-')[0] ?? '';

/** The Mirror Node form of a recorded transaction ID, or null if it is malformed. */
const mirrorIdOrNull = (transactionId: string): string | null => {
  try {
    return toMirrorTransactionId(transactionId);
  } catch {
    return null;
  }
};

/**
 * Tinybars the payer paid in x402 transfers among `transactions`, skipping the
 * transaction IDs in `known` (Mirror Node form). Pure.
 */
export function x402SpendOf(
  transactions: readonly MirrorTransaction[],
  payer: string,
  known: ReadonlySet<string>,
): {
  readonly tinybars: bigint;
  readonly count: number;
  /** The same amounts per payee (D-066): the one account credited exactly the payer's debit. */
  readonly byPayee: Readonly<Record<string, bigint>>;
} {
  let tinybars = 0n;
  let count = 0;
  const byPayee: Record<string, bigint> = {};
  const seen = new Set<string>();
  for (const tx of transactions) {
    if (tx.result !== 'SUCCESS') continue;
    if (seen.has(tx.transactionId)) continue; // a page boundary can repeat an entry
    seen.add(tx.transactionId);
    if (known.has(tx.transactionId)) continue;
    if (feePayerOf(tx.transactionId) === payer) continue;
    const debit = tx.transfers
      .filter((t) => t.account === payer && t.amount < 0n)
      .reduce((s, t) => s - t.amount, 0n);
    if (debit === 0n) continue;
    tinybars += debit;
    count += 1;
    // the facilitator pays the fees, so the payee is credited exactly what the payer lost
    const payees = tx.transfers.filter((t) => t.account !== payer && t.amount === debit);
    const payee = payees.length === 1 ? payees[0]?.account : undefined;
    if (payee !== undefined) byPayee[payee] = (byPayee[payee] ?? 0n) + debit;
  }
  return { tinybars, count, byPayee };
}

export interface ChainSpendFloorDeps {
  readonly payer: string;
  readonly mirror: {
    listAccountTransfers(
      accountId: string,
      fromSeconds: number,
      toSeconds: number,
    ): Promise<MirrorTransaction[]>;
  };
  /** Transaction IDs (any form) of this database's payments. */
  readonly knownTransactionIds: () => readonly string[];
  readonly now?: () => Date;
}

export interface FloorReading {
  readonly day: string;
  readonly tinybars: bigint;
  readonly count: number;
  /** Outside spend per payee account (D-066). */
  readonly byPayee: Readonly<Record<string, bigint>>;
  readonly readAt: string;
}

export class ChainSpendFloor {
  readonly #d: ChainSpendFloorDeps;
  #last: FloorReading | null = null;

  constructor(deps: ChainSpendFloorDeps) {
    this.#d = deps;
  }

  /** Read today's outside spend from the Mirror Node. Throws if it cannot be read. */
  async refresh(): Promise<FloorReading> {
    const now = (this.#d.now ?? (() => new Date()))();
    const day = now.toISOString().slice(0, 10);
    const from = Date.parse(`${day}T00:00:00.000Z`) / 1000;
    // through the end of the day: a transfer reaching consensus seconds ago is included
    const txs = await this.#d.mirror.listAccountTransfers(this.#d.payer, from, from + 86_400);
    const known = new Set(
      this.#d
        .knownTransactionIds()
        .map(mirrorIdOrNull)
        .filter((id): id is string => id !== null),
    );
    const spend = x402SpendOf(txs, this.#d.payer, known);
    this.#last = { day, ...spend, readAt: now.toISOString() };
    return this.#last;
  }

  /**
   * Outside spend for the UTC day starting at `dayStart` (ISO): the last
   * reading if it is for that day, else 0 (a later day began after the last
   * reading, so everything since then is in this database).
   */
  floorFor(dayStart: string): bigint {
    return this.#last !== null && dayStart.startsWith(this.#last.day) ? this.#last.tinybars : 0n;
  }

  /** The same, per payee account (D-066). */
  payeeFloorFor(dayStart: string): Readonly<Record<string, bigint>> {
    return this.#last !== null && dayStart.startsWith(this.#last.day) ? this.#last.byPayee : {};
  }

  /** The last reading, for the API (null before the first). */
  get last(): FloorReading | null {
    return this.#last;
  }
}
