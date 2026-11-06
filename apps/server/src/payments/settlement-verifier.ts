/**
 * Settlement verifier (plan row 22, D-044): the only component that decides,
 * from the Hedera Mirror Node, whether a payment settled.
 *
 * What it checks, per payment (packages/hedera: reconcileWithMirror and
 * verifyHbarSettlement):
 *   - network: the payment's network is the Mirror Node's network
 *   - asset: HBAR (HTS settlement is plan row 37)
 *   - the exact transaction ID, every consensus entry for it
 *   - status SUCCESS, a CRYPTOTRANSFER, no token transfers
 *   - payee credited exactly the authorised amount (payTo from ENS, D-041)
 *   - payer debited exactly that amount (the facilitator pays the fees)
 *   - consensus not before the transaction's valid start
 *
 * Every Mirror Node reading is stored as an append-only verification row. The
 * database refuses SETTLED unless a SETTLED verification for that payment and
 * transaction ID exists (migration 4), so no code path can settle a payment
 * the Mirror Node has not confirmed. A facilitator's `success` and an HTTP 200
 * are recorded elsewhere and never consulted here.
 */
import { randomUUID } from 'node:crypto';
import type { PaymentIntent } from '@agent-economy/core/domain';
import { toMirrorTransactionId, type MirrorTransaction } from '@agent-economy/hedera';
import type { PaymentStore, SettlementVerification } from './payment-store.ts';
import { verificationOf, verifyPayment, type PaymentStateMachine } from './state-machine.ts';

export interface MirrorReader {
  readonly baseUrl: string;
  getTransactions(mirrorTransactionId: string): Promise<MirrorTransaction[]>;
}

export interface VerifierOptions {
  readonly machine: PaymentStateMachine;
  readonly store: PaymentStore;
  readonly mirror: MirrorReader;
  readonly network: 'testnet' | 'mainnet';
  readonly payer: string;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Mirror Node polling after a submission (default 3 s, up to 45 s: D-018). */
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly newId?: () => string;
}

export type VerifyOutcome = 'SETTLED' | 'FAILED' | 'UNKNOWN';

export interface SettlementResult {
  readonly intent: PaymentIntent;
  readonly outcome: VerifyOutcome;
  readonly entries: readonly MirrorTransaction[];
  readonly verifications: readonly SettlementVerification[];
}

export interface AuditRow {
  readonly intent: PaymentIntent;
  readonly verification: SettlementVerification;
  /** The SETTLED status is still confirmed by the Mirror Node right now. */
  readonly confirmed: boolean;
}

export class SettlementVerifier {
  readonly #o: VerifierOptions;

  constructor(options: VerifierOptions) {
    this.#o = options;
  }

  #now(): Date {
    return (this.#o.now ?? (() => new Date()))();
  }

  async #entries(transactionId: string): Promise<MirrorTransaction[]> {
    return this.#o.mirror.getTransactions(toMirrorTransactionId(transactionId));
  }

  #reconcileOptions() {
    return { mirrorNode: this.#o.mirror.baseUrl, mirrorNetwork: this.#o.network } as const;
  }

  /**
   * Right after the paid request: poll until the Mirror Node has an entry (or
   * the timeout), then decide. SETTLED and FAILED only from a Mirror Node
   * verdict; anything else becomes UNKNOWN (never retried, reconciled later).
   */
  async awaitSettlement(paymentId: string): Promise<SettlementResult> {
    const p = await this.#o.store.get(paymentId);
    if (p === null || p.status !== 'SUBMITTED' || p.transactionId === null)
      throw new Error(`payment ${paymentId} is not a SUBMITTED payment with a transaction ID`);
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = this.#now().getTime() + (this.#o.timeoutMs ?? 45_000);
    let entries: MirrorTransaction[] = [];
    for (;;) {
      entries = await this.#entries(p.transactionId).catch(() => []);
      if (entries.length > 0 || this.#now().getTime() >= deadline) break;
      await sleep(this.#o.pollIntervalMs ?? 3_000);
    }
    const r = await this.#o.machine.reconcile(
      paymentId,
      entries,
      this.#o.payer,
      this.#reconcileOptions(),
    );
    const done = async (
      intent: PaymentIntent,
      outcome: VerifyOutcome,
    ): Promise<SettlementResult> => ({
      intent,
      outcome,
      entries,
      verifications: await this.#o.store.verifications(paymentId),
    });
    if (r.outcome === 'SETTLED' || r.outcome === 'FAILED') return done(r.intent, r.outcome);
    const code = entries.length === 0 ? 'MIRROR_TIMEOUT' : (r.intent.errorCode ?? r.outcome);
    return done(await this.#o.machine.recordUnknown(paymentId, code), 'UNKNOWN');
  }

  /** One pass over every SUBMITTED / UNKNOWN payment. */
  async reconcileOpen(): Promise<{ intent: PaymentIntent; outcome: string }[]> {
    const out: { intent: PaymentIntent; outcome: string }[] = [];
    for (const p of await this.#o.store.listByStatus(['SUBMITTED', 'UNKNOWN'])) {
      if (p.transactionId === null) continue;
      const entries = await this.#entries(p.transactionId);
      const r = await this.#o.machine.reconcile(
        p.id,
        entries,
        this.#o.payer,
        this.#reconcileOptions(),
      );
      out.push({ intent: r.intent, outcome: r.outcome });
    }
    return out;
  }

  /**
   * Re-verify SETTLED payments against the Mirror Node now, recording each
   * reading. A SETTLED payment cannot be un-settled; a failed re-verification
   * is reported for a human (it would mean the record and the chain disagree).
   */
  async audit(): Promise<AuditRow[]> {
    const rows: AuditRow[] = [];
    for (const p of await this.#o.store.listByStatus(['SETTLED'])) {
      if (p.transactionId === null) continue;
      const entries = await this.#entries(p.transactionId);
      const at = this.#now().toISOString();
      const verdict = verifyPayment(p, entries, this.#o.payer, at, this.#reconcileOptions());
      const v = verificationOf(
        (this.#o.newId ?? randomUUID)(),
        p,
        verdict,
        entries.length,
        at,
        this.#reconcileOptions(),
      );
      await this.#o.store.recordVerification(v);
      rows.push({ intent: p, verification: v, confirmed: verdict.outcome === 'SETTLED' });
    }
    return rows;
  }
}
