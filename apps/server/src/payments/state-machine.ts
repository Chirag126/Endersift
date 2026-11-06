/**
 * Payment state machine (plan row 20, D-042). Every payment the agent makes
 * moves through these steps, each persisted before the next action:
 *
 *   open        CREATED     one intent per purchase (idempotency key); opening the
 *                           same purchase again returns the existing intent, in
 *                           whatever status it is, so a retry never pays twice
 *   decide      AUTHORIZED  the firewall allowed exactly this amount and payee
 *               REFUSED     the firewall's reason code
 *   sign        SIGNED      the transaction ID is recorded BEFORE anything is sent;
 *                           only an AUTHORIZED intent without a transaction ID may
 *                           be signed (compare-and-set: one signer wins)
 *   submit      SUBMITTED   recorded BEFORE the paid request leaves the process
 *   settle      SETTLED     only with a Mirror Node verdict (exact payee, payer, amount)
 *   unknown     UNKNOWN     no verdict in time; never retried, never re-signed
 *   fail        FAILED      before submission: freely; after submission: only on a
 *                           Mirror Node verdict (failed result, or expired unseen)
 *   reconcile   SUBMITTED/UNKNOWN → SETTLED | FAILED, or unchanged (attempt counted)
 *
 * The domain table (PAYMENT_TRANSITIONS) and the database triggers allow the
 * same edges; this module adds the preconditions (who may sign, what evidence
 * settles or fails a submitted payment).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  PAYMENT_TRANSITIONS,
  type PaymentIntent,
  type PaymentStatus,
  type ProviderAgent,
} from '@agent-economy/core/domain';
import {
  reconcileWithMirror,
  type MirrorTransaction,
  type ReconcileVerdict,
} from '@agent-economy/hedera';
import type { Decision, SpendState } from '@agent-economy/policy';
import type { PaymentStore, SettlementVerification, TransitionPatch } from './payment-store.ts';

export class PaymentStateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PaymentStateError';
    this.code = code;
  }
}

/** sha256 over the purchase identity. The same run buying the same thing at the same URL = same key. */
export function paymentIdempotencyKey(input: {
  readonly runId: string;
  readonly provider: string;
  readonly capability: string;
  readonly requestUrl: string;
}): string {
  const url = new URL(input.requestUrl);
  url.searchParams.sort();
  url.hash = '';
  return createHash('sha256')
    .update(JSON.stringify([input.runId, input.provider, input.capability, url.toString()]), 'utf8')
    .digest('hex');
}

export interface OpenInput {
  readonly runId: string;
  readonly provider: ProviderAgent;
  readonly capability: string;
  readonly requestUrl: string;
}

export interface Clock {
  readonly now?: () => Date;
  readonly newId?: () => string;
  /**
   * Today's spend this database does not know about (the Mirror Node reading,
   * D-062), added to the day's committed spend the firewall sees. Absent = 0.
   */
  readonly dayFloor?: (dayStart: string) => bigint;
  /** The same reading per payee account (D-066), added to the per-provider spend. Absent = none. */
  readonly payeeFloor?: (dayStart: string) => Readonly<Record<string, bigint>>;
}

export class PaymentStateMachine {
  readonly #store: PaymentStore;
  readonly #now: () => string;
  readonly #newId: () => string;
  readonly #dayFloor: (dayStart: string) => bigint;
  readonly #payeeFloor: (dayStart: string) => Readonly<Record<string, bigint>>;

  constructor(store: PaymentStore, clock: Clock = {}) {
    this.#store = store;
    const now = clock.now ?? (() => new Date());
    this.#now = () => now().toISOString();
    this.#newId = clock.newId ?? randomUUID;
    this.#dayFloor = clock.dayFloor ?? (() => 0n);
    this.#payeeFloor = clock.payeeFloor ?? (() => ({}));
  }

  async #require(id: string): Promise<PaymentIntent> {
    const p = await this.#store.get(id);
    if (p === null) throw new PaymentStateError('NOT_FOUND', `payment ${id} does not exist`);
    return p;
  }

  async #move(
    p: PaymentIntent,
    to: PaymentStatus,
    patch: TransitionPatch,
    detail: Record<string, unknown>,
    verification?: SettlementVerification,
  ): Promise<PaymentIntent> {
    if (!PAYMENT_TRANSITIONS[p.status].includes(to)) {
      throw new PaymentStateError(
        'ILLEGAL_TRANSITION',
        `illegal payment transition ${p.status} → ${to} (${p.id})`,
      );
    }
    return this.#store.transition({
      id: p.id,
      from: p.status,
      to,
      patch,
      detail,
      at: this.#now(),
      ...(verification === undefined ? {} : { verification }),
    });
  }

  /** CREATED, or the existing intent for the same purchase (`created: false`). */
  async open(input: OpenInput): Promise<{ intent: PaymentIntent; created: boolean }> {
    const at = this.#now();
    return this.#store.insert({
      id: this.#newId(),
      runId: input.runId,
      provider: input.provider.ensName,
      payTo: input.provider.payTo,
      network: input.provider.network,
      asset: input.provider.asset,
      amountAtomic: input.provider.priceAtomic,
      idempotencyKey: paymentIdempotencyKey({
        runId: input.runId,
        provider: input.provider.ensName,
        capability: input.capability,
        requestUrl: input.requestUrl,
      }),
      capability: input.capability,
      requestUrl: input.requestUrl,
      status: 'CREATED',
      refusalCode: null,
      transactionId: null,
      facilitator: null,
      errorCode: null,
      settledAt: null,
      reconcileAttempts: 0,
      lastCheckedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  }

  /**
   * Apply the firewall decision. An ALLOW must be for this exact intent
   * (provider, payee, amount, capability); anything else is a programming
   * error and refuses the payment instead of authorising it.
   */
  async decide(id: string, decision: Decision): Promise<PaymentIntent> {
    const p = await this.#require(id);
    if (p.status !== 'CREATED')
      throw new PaymentStateError('NOT_CREATED', `payment ${id} is ${p.status}, not CREATED`);
    if (!decision.allow)
      return this.#move(
        p,
        'REFUSED',
        { refusalCode: decision.code },
        {
          code: decision.code,
          violations: decision.violations.map((v) => v.code),
        },
      );
    const matches =
      decision.provider.ensName === p.provider &&
      decision.provider.payTo === p.payTo &&
      decision.amount.toString() === p.amountAtomic &&
      decision.intent.capability === p.capability;
    if (!matches)
      return this.#move(
        p,
        'REFUSED',
        { refusalCode: 'DECISION_MISMATCH' },
        {
          code: 'DECISION_MISMATCH',
          decision: { provider: decision.provider.ensName, amount: decision.amount.toString() },
        },
      );
    return this.#move(p, 'AUTHORIZED', {}, { amount: p.amountAtomic, payTo: p.payTo });
  }

  /** Throws unless this intent may be signed now: AUTHORIZED and never signed before. */
  assertSignable(p: PaymentIntent): void {
    if (p.transactionId !== null)
      throw new PaymentStateError(
        'ALREADY_SIGNED',
        `payment ${p.id} already has transaction ${p.transactionId}; it is never signed again`,
      );
    if (p.status !== 'AUTHORIZED')
      throw new PaymentStateError(
        'NOT_SIGNABLE',
        `payment ${p.id} is ${p.status}; only an AUTHORIZED payment may be signed`,
      );
  }

  /** Record the transaction ID before the signed payment is sent anywhere. */
  async recordSigned(
    id: string,
    transactionId: string,
    facilitator: string,
  ): Promise<PaymentIntent> {
    const p = await this.#require(id);
    this.assertSignable(p);
    return this.#move(p, 'SIGNED', { transactionId, facilitator }, { transactionId, facilitator });
  }

  /** Record that the signed payment is about to leave the process (from now on: unknown until verified). */
  async recordSubmitted(id: string): Promise<PaymentIntent> {
    const p = await this.#require(id);
    if (p.status !== 'SIGNED')
      throw new PaymentStateError('NOT_SIGNED', `payment ${id} is ${p.status}, not SIGNED`);
    return this.#move(p, 'SUBMITTED', {}, {});
  }

  /** Settlement could not be verified in time: never retried, never re-signed. */
  async recordUnknown(id: string, errorCode: string): Promise<PaymentIntent> {
    const p = await this.#require(id);
    if (p.status !== 'SUBMITTED')
      throw new PaymentStateError('NOT_SUBMITTED', `payment ${id} is ${p.status}, not SUBMITTED`);
    return this.#move(p, 'UNKNOWN', { errorCode }, { errorCode });
  }

  /** Before submission only: the signed payment never left the process. */
  async recordFailedBeforeSubmit(id: string, errorCode: string): Promise<PaymentIntent> {
    const p = await this.#require(id);
    if (p.status !== 'AUTHORIZED' && p.status !== 'SIGNED')
      throw new PaymentStateError(
        'NEEDS_MIRROR_VERDICT',
        `payment ${id} is ${p.status}; after submission only a Mirror Node verdict can fail it`,
      );
    return this.#move(p, 'FAILED', { errorCode }, { errorCode, beforeSubmit: true });
  }

  /**
   * Settle or fail a SUBMITTED / UNKNOWN payment from the Mirror Node's entries
   * for its transaction ID. PENDING and MISMATCH leave the status unchanged and
   * count the attempt (MISMATCH is flagged for a human: money moved, but not as
   * authorised).
   */
  async reconcile(
    id: string,
    entries: readonly MirrorTransaction[],
    payer: string,
    options: ReconcileOptions = {},
  ): Promise<{ intent: PaymentIntent; outcome: ReconcileVerdict['outcome'] }> {
    const p = await this.#require(id);
    if (p.status !== 'SUBMITTED' && p.status !== 'UNKNOWN')
      throw new PaymentStateError(
        'NOT_RECONCILABLE',
        `payment ${id} is ${p.status}; only SUBMITTED or UNKNOWN payments are reconciled`,
      );
    if (p.transactionId === null)
      throw new PaymentStateError('NO_TRANSACTION_ID', `payment ${id} has no transaction ID`);
    const now = this.#now();
    const verdict = verifyPayment(p, entries, payer, now, options);
    const verification = verificationOf(this.#newId(), p, verdict, entries.length, now, options);
    switch (verdict.outcome) {
      case 'SETTLED':
        return {
          outcome: 'SETTLED',
          intent: await this.#move(
            p,
            'SETTLED',
            { settledAt: now, errorCode: null },
            {
              consensusTimestamp: verdict.transaction.consensusTimestamp,
              checks: verification.checks,
            },
            verification,
          ),
        };
      case 'FAILED':
        return {
          outcome: 'FAILED',
          intent: await this.#move(
            p,
            'FAILED',
            { errorCode: verdict.code },
            { errorCode: verdict.code, detail: verdict.detail },
            verification,
          ),
        };
      case 'MISMATCH':
      case 'PENDING':
      case 'UNVERIFIABLE':
        return {
          outcome: verdict.outcome,
          intent: await this.#store.noteCheck(p.id, p.status, verdict.code, now, verification),
        };
    }
  }

  /** The firewall's SpendState for a run on a UTC day, from the persisted intents. */
  async spendState(runId: string, dayStart: string, dayEnd: string): Promise<SpendState> {
    const c = await this.#store.committed({ runId, dayStart, dayEnd });
    return {
      runCommitted: c.run,
      dayCommitted: c.day + this.#dayFloor(dayStart),
      runPayments: c.runPayments,
      runPurchases: c.runPurchases,
      dayCommittedByPayee: addByKey(c.dayByPayee, this.#payeeFloor(dayStart)),
    };
  }
}

export interface ReconcileOptions {
  readonly expiryAfterSec?: number;
  /** The Mirror Node base URL the entries came from (recorded on the verification). */
  readonly mirrorNode?: string;
  /** The Mirror Node's network; a payment on another network is UNVERIFIABLE (D-044). */
  readonly mirrorNetwork?: 'testnet' | 'mainnet';
}

/** The pure Mirror Node verdict for an intent (status, payee, payer, amount, network, asset). */
export function verifyPayment(
  p: PaymentIntent,
  entries: readonly MirrorTransaction[],
  payer: string,
  now: string,
  options: ReconcileOptions = {},
): ReconcileVerdict {
  if (p.transactionId === null)
    throw new PaymentStateError('NO_TRANSACTION_ID', `payment ${p.id} has no transaction ID`);
  return reconcileWithMirror({
    expected: {
      transactionId: p.transactionId,
      payer,
      payTo: p.payTo,
      amount: BigInt(p.amountAtomic),
    },
    entries,
    now,
    payment: { network: p.network, asset: p.asset },
    ...(options.mirrorNetwork === undefined ? {} : { mirrorNetwork: options.mirrorNetwork }),
    ...(options.expiryAfterSec === undefined ? {} : { expiryAfterSec: options.expiryAfterSec }),
  });
}

export function verificationOf(
  id: string,
  p: PaymentIntent,
  verdict: ReconcileVerdict,
  entries: number,
  at: string,
  options: ReconcileOptions = {},
): SettlementVerification {
  const checks =
    verdict.outcome === 'SETTLED' || verdict.outcome === 'MISMATCH'
      ? verdict.checks.map((c) => `${c.ok ? 'OK' : 'FAIL'} ${c.name}: ${c.detail}`)
      : [verdict.detail];
  return {
    id,
    paymentId: p.id,
    transactionId: p.transactionId ?? '',
    mirrorNode: options.mirrorNode ?? 'unknown',
    outcome: verdict.outcome,
    code: verdict.outcome === 'SETTLED' ? null : verdict.code,
    consensusTimestamp:
      verdict.outcome === 'SETTLED' || verdict.outcome === 'MISMATCH'
        ? verdict.transaction.consensusTimestamp
        : null,
    checks,
    entries,
    verifiedAt: at,
  };
}

/** Two per-key amount maps added together. Pure. */
export function addByKey(
  a: Readonly<Record<string, bigint>>,
  b: Readonly<Record<string, bigint>>,
): Record<string, bigint> {
  const out: Record<string, bigint> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0n) + v;
  return out;
}
