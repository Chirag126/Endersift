/**
 * What the agent earned (D-066): x402 payments INTO its earnings account,
 * read from the Hedera Mirror Node only, never from this database.
 *
 * The agent sells its latest brief through the provider service
 * (`/v1/agent/brief`, paid to AGENT_EARNINGS_ACCOUNT). A sale counts when the
 * Mirror Node shows a successful CRYPTOTRANSFER that credits the earnings
 * account while another account paid the fee (the x402 facilitator), exactly
 * like the spend side (chain-floor.ts). A purchase by the agent's own payer is
 * still counted but flagged, so a self-test is never shown as revenue from
 * someone else.
 */
import type { MirrorTransaction } from '@agent-economy/hedera';

export interface EarningSale {
  readonly transactionId: string;
  readonly consensusTimestamp: string;
  readonly tinybars: bigint;
  /** The account debited for the sale (the buyer), when exactly one was. */
  readonly buyer: string | null;
  /** The buyer is this agent's own payer: a self-test, not outside revenue. */
  readonly fromOwnPayer: boolean;
}

export interface EarningsReading {
  readonly account: string;
  readonly fromSeconds: number;
  readonly toSeconds: number;
  readonly tinybars: bigint;
  /** The part paid by anyone other than the agent's own payer. */
  readonly outsideTinybars: bigint;
  readonly sales: readonly EarningSale[];
  readonly readAt: string;
}

const feePayerOf = (mirrorTransactionId: string): string => mirrorTransactionId.split('-')[0] ?? '';

/** Sales among `transactions` into `account`. Pure. */
export function salesOf(
  transactions: readonly MirrorTransaction[],
  account: string,
  ownPayer: string | null,
): EarningSale[] {
  const out: EarningSale[] = [];
  const seen = new Set<string>();
  for (const tx of transactions) {
    if (tx.result !== 'SUCCESS' || tx.name !== 'CRYPTOTRANSFER') continue;
    if (seen.has(tx.transactionId)) continue;
    seen.add(tx.transactionId);
    // the facilitator pays the fee in x402; the account's own transfers are not sales
    if (feePayerOf(tx.transactionId) === account) continue;
    const credit = tx.transfers
      .filter((t) => t.account === account && t.amount > 0n)
      .reduce((s, t) => s + t.amount, 0n);
    if (credit === 0n) continue;
    const debited = tx.transfers.filter((t) => t.amount === -credit && t.account !== account);
    const buyer = debited.length === 1 ? (debited[0]?.account ?? null) : null;
    out.push({
      transactionId: tx.transactionId,
      consensusTimestamp: tx.consensusTimestamp,
      tinybars: credit,
      buyer,
      fromOwnPayer: buyer !== null && buyer === ownPayer,
    });
  }
  return out;
}

export interface EarningsReaderDeps {
  readonly account: string;
  /** This agent's paying account, to flag self-purchases. */
  readonly ownPayer: string | null;
  readonly mirror: {
    listAccountTransfers(
      accountId: string,
      fromSeconds: number,
      toSeconds: number,
    ): Promise<MirrorTransaction[]>;
  };
  /** How far back to read (days). */
  readonly days?: number;
  /** A reading younger than this is reused instead of asking the Mirror Node again. */
  readonly maxAgeMs?: number;
  readonly now?: () => Date;
}

export class EarningsReader {
  readonly #d: EarningsReaderDeps;
  #last: EarningsReading | null = null;
  #inFlight: Promise<EarningsReading> | null = null;

  constructor(deps: EarningsReaderDeps) {
    this.#d = deps;
  }

  get account(): string {
    return this.#d.account;
  }

  /** The latest reading, refreshed when older than `maxAgeMs`. Throws if the Mirror Node fails. */
  async read(): Promise<EarningsReading> {
    const now = (this.#d.now ?? (() => new Date()))();
    const maxAge = this.#d.maxAgeMs ?? 60_000;
    if (this.#last !== null && now.getTime() - Date.parse(this.#last.readAt) < maxAge)
      return this.#last;
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = (async () => {
      const to = Math.ceil(now.getTime() / 1000);
      const from = to - (this.#d.days ?? 7) * 86_400;
      const txs = await this.#d.mirror.listAccountTransfers(this.#d.account, from, to);
      const sales = salesOf(txs, this.#d.account, this.#d.ownPayer);
      const sum = (list: readonly EarningSale[]) => list.reduce((s, x) => s + x.tinybars, 0n);
      const reading: EarningsReading = {
        account: this.#d.account,
        fromSeconds: from,
        toSeconds: to,
        tinybars: sum(sales),
        outsideTinybars: sum(sales.filter((x) => !x.fromOwnPayer)),
        sales,
        readAt: now.toISOString(),
      };
      this.#last = reading;
      return reading;
    })();
    try {
      return await this.#inFlight;
    } finally {
      this.#inFlight = null;
    }
  }
}
