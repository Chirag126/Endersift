/**
 * Persistence for payment intents (plan row 20, D-042), behind an async
 * interface so the Render deployment can add Postgres (D-031).
 *
 * Two properties the state machine relies on:
 *   - insert is idempotent on `idempotency_key`: a second insert for the same
 *     purchase returns the existing row (whatever its status), never a new one;
 *   - transition is compare-and-set: it only applies when the row is still in
 *     the status the caller read, so two workers cannot both move it (for
 *     example, both sign it). Every applied transition is appended to
 *     `payment_transitions` in the same transaction.
 * The database triggers (migrations 1 and 3) enforce the allowed transitions,
 * immutable transaction IDs and purchase identity a second time.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  COMMITTED_PAYMENT_STATUSES,
  PaymentIntent,
  canTransition,
  type PaymentStatus,
} from '@agent-economy/core/domain';

type Row = Record<string, unknown>;
type MaybeRow = Row | undefined;

export class PaymentStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentStoreError';
  }
}

/** Thrown when the row is no longer in the expected status (someone else moved it). */
export class StaleTransitionError extends PaymentStoreError {
  constructor(id: string, expected: PaymentStatus, actual: PaymentStatus | null) {
    super(`payment ${id} is ${actual ?? 'missing'}, not ${expected}; transition not applied`);
    this.name = 'StaleTransitionError';
  }
}

export interface PaymentTransition {
  readonly paymentId: string;
  readonly seq: number;
  readonly from: PaymentStatus | null;
  readonly to: PaymentStatus;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
}

/** Fields a transition may set; identity fields never change. */
export interface TransitionPatch {
  readonly transactionId?: string;
  readonly facilitator?: string;
  readonly refusalCode?: string;
  readonly errorCode?: string | null;
  readonly settledAt?: string;
}

export const VERIFICATION_OUTCOMES = [
  'SETTLED',
  'MISMATCH',
  'FAILED',
  'PENDING',
  'UNVERIFIABLE',
] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

/** One Mirror Node verification of a payment (append-only, D-044). */
export interface SettlementVerification {
  readonly id: string;
  readonly paymentId: string;
  readonly transactionId: string;
  readonly mirrorNode: string;
  readonly outcome: VerificationOutcome;
  readonly code: string | null;
  readonly consensusTimestamp: string | null;
  readonly checks: readonly string[];
  readonly entries: number;
  readonly verifiedAt: string;
}

export interface CommittedSpend {
  readonly run: bigint;
  readonly day: bigint;
  readonly runPayments: number;
  readonly runPurchases: readonly { provider: string; capability: string }[];
  /** Committed today per payee account (D-066), for the per-provider caps. */
  readonly dayByPayee: Readonly<Record<string, bigint>>;
}

export interface PaymentStore {
  insert(intent: PaymentIntent): Promise<{ intent: PaymentIntent; created: boolean }>;
  get(id: string): Promise<PaymentIntent | null>;
  getByKey(idempotencyKey: string): Promise<PaymentIntent | null>;
  listByRun(runId: string): Promise<PaymentIntent[]>;
  listByStatus(statuses: readonly PaymentStatus[]): Promise<PaymentIntent[]>;
  transition(input: {
    readonly id: string;
    readonly from: PaymentStatus;
    readonly to: PaymentStatus;
    readonly patch: TransitionPatch;
    readonly detail: Readonly<Record<string, unknown>>;
    readonly at: string;
    /** Written in the same transaction, before the status change (SETTLED requires one). */
    readonly verification?: SettlementVerification;
  }): Promise<PaymentIntent>;
  /** Count a reconciliation attempt that changed nothing (status stays). */
  noteCheck(
    id: string,
    from: PaymentStatus,
    errorCode: string | null,
    at: string,
    verification?: SettlementVerification,
  ): Promise<PaymentIntent>;
  /** Append a verification that changes no status (audits of SETTLED payments). */
  recordVerification(v: SettlementVerification): Promise<SettlementVerification>;
  verifications(paymentId: string): Promise<SettlementVerification[]>;
  history(id: string): Promise<PaymentTransition[]>;
  /**
   * What the firewall's SpendState needs: amounts in COMMITTED_PAYMENT_STATUSES for the run
   * and for [dayStart, dayEnd), the payments started this run (anything past CREATED except
   * REFUSED), and the provider/capability pairs committed this run.
   */
  committed(input: {
    readonly runId: string;
    readonly dayStart: string;
    readonly dayEnd: string;
  }): Promise<CommittedSpend>;
}

function fromRow(r: Row): PaymentIntent {
  return PaymentIntent.parse({
    id: r['id'],
    runId: r['run_id'],
    provider: r['provider'],
    payTo: r['pay_to'],
    network: r['network'],
    asset: r['asset'],
    amountAtomic: r['amount_atomic'],
    idempotencyKey: r['idempotency_key'],
    capability: r['capability'],
    requestUrl: r['request_url'],
    status: r['status'],
    refusalCode: r['refusal_code'],
    transactionId: r['transaction_id'],
    facilitator: r['facilitator'],
    errorCode: r['error_code'],
    settledAt: r['settled_at'],
    reconcileAttempts: Number(r['reconcile_attempts']),
    lastCheckedAt: r['last_checked_at'],
    createdAt: r['created_at'],
    updatedAt: r['updated_at'],
  });
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

export class SqlitePaymentStore implements PaymentStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.#db.exec('COMMIT');
      return out;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #get(id: string): PaymentIntent | null {
    const row = this.#db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(id) as MaybeRow;
    return row === undefined ? null : fromRow(row);
  }

  #getByKey(key: string): PaymentIntent | null {
    const stmt = this.#db.prepare('SELECT * FROM payment_intents WHERE idempotency_key = ?');
    const row = stmt.get(key) as MaybeRow;
    return row === undefined ? null : fromRow(row);
  }

  #appendTransition(t: Omit<PaymentTransition, 'seq'>): void {
    const next = this.#db
      .prepare(
        'SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM payment_transitions WHERE payment_id = ?',
      )
      .get(t.paymentId) as { next: number };
    this.#db
      .prepare(
        'INSERT INTO payment_transitions (payment_id, seq, from_status, to_status, detail, at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(t.paymentId, Number(next.next), t.from, t.to, JSON.stringify(t.detail), t.at);
  }

  #insertVerification(v: SettlementVerification): void {
    this.#db
      .prepare(
        `INSERT INTO settlement_verifications (id, payment_id, transaction_id, mirror_node, outcome, code,
           consensus_timestamp, checks, entries, verified_at) VALUES (${placeholders(10)})`,
      )
      .run(
        v.id,
        v.paymentId,
        v.transactionId,
        v.mirrorNode,
        v.outcome,
        v.code,
        v.consensusTimestamp,
        JSON.stringify(v.checks),
        v.entries,
        v.verifiedAt,
      );
  }

  async recordVerification(v: SettlementVerification): Promise<SettlementVerification> {
    this.#insertVerification(v);
    return v;
  }

  async verifications(paymentId: string): Promise<SettlementVerification[]> {
    const stmt = this.#db.prepare(
      'SELECT * FROM settlement_verifications WHERE payment_id = ? ORDER BY verified_at, rowid',
    );
    return (stmt.all(paymentId) as Row[]).map((r) => ({
      id: String(r['id']),
      paymentId: String(r['payment_id']),
      transactionId: String(r['transaction_id']),
      mirrorNode: String(r['mirror_node']),
      outcome: r['outcome'] as VerificationOutcome,
      code: (r['code'] ?? null) as string | null,
      consensusTimestamp: (r['consensus_timestamp'] ?? null) as string | null,
      checks: JSON.parse(String(r['checks'])) as string[],
      entries: Number(r['entries']),
      verifiedAt: String(r['verified_at']),
    }));
  }

  async insert(input: PaymentIntent): Promise<{ intent: PaymentIntent; created: boolean }> {
    const p = PaymentIntent.parse(input);
    if (p.status !== 'CREATED') throw new PaymentStoreError('payment intents start in CREATED');
    return this.#tx(() => {
      const existing = this.#getByKey(p.idempotencyKey);
      if (existing !== null) return { intent: existing, created: false };
      this.#db
        .prepare(
          `INSERT INTO payment_intents (id, run_id, provider, pay_to, network, asset, amount_atomic, status,
             refusal_code, transaction_id, facilitator, created_at, updated_at, idempotency_key, capability,
             request_url, error_code, settled_at, reconcile_attempts, last_checked_at)
           VALUES (${placeholders(20)})`,
        )
        .run(
          p.id,
          p.runId,
          p.provider,
          p.payTo,
          p.network,
          p.asset,
          p.amountAtomic,
          p.status,
          p.refusalCode,
          p.transactionId,
          p.facilitator,
          p.createdAt,
          p.updatedAt,
          p.idempotencyKey,
          p.capability,
          p.requestUrl,
          p.errorCode,
          p.settledAt,
          p.reconcileAttempts,
          p.lastCheckedAt,
        );
      this.#appendTransition({
        paymentId: p.id,
        from: null,
        to: 'CREATED',
        detail: { amount: p.amountAtomic, payTo: p.payTo, provider: p.provider },
        at: p.createdAt,
      });
      return { intent: p, created: true };
    });
  }

  async get(id: string): Promise<PaymentIntent | null> {
    return this.#get(id);
  }

  async getByKey(key: string): Promise<PaymentIntent | null> {
    return this.#getByKey(key);
  }

  async listByRun(runId: string): Promise<PaymentIntent[]> {
    const stmt = this.#db.prepare(
      'SELECT * FROM payment_intents WHERE run_id = ? ORDER BY created_at, id',
    );
    return (stmt.all(runId) as Row[]).map(fromRow);
  }

  /** The most recent payments across runs, newest first. */
  async listRecent(limit: number): Promise<PaymentIntent[]> {
    const stmt = this.#db.prepare(
      'SELECT * FROM payment_intents ORDER BY created_at DESC, id DESC LIMIT ?',
    );
    return (stmt.all(Math.max(1, Math.min(limit, 200))) as Row[]).map(fromRow);
  }

  async listByStatus(statuses: readonly PaymentStatus[]): Promise<PaymentIntent[]> {
    if (statuses.length === 0) return [];
    const stmt = this.#db.prepare(
      `SELECT * FROM payment_intents WHERE status IN (${placeholders(statuses.length)}) ORDER BY created_at, id`,
    );
    return (stmt.all(...statuses) as Row[]).map(fromRow);
  }

  async transition(input: {
    readonly id: string;
    readonly from: PaymentStatus;
    readonly to: PaymentStatus;
    readonly patch: TransitionPatch;
    readonly detail: Readonly<Record<string, unknown>>;
    readonly at: string;
    readonly verification?: SettlementVerification;
  }): Promise<PaymentIntent> {
    if (!canTransition(input.from, input.to))
      throw new PaymentStoreError(`illegal payment transition ${input.from} → ${input.to}`);
    return this.#tx(() => {
      const current = this.#get(input.id);
      if (current === null || current.status !== input.from)
        throw new StaleTransitionError(input.id, input.from, current?.status ?? null);
      const next = PaymentIntent.parse({
        ...current,
        status: input.to,
        transactionId: input.patch.transactionId ?? current.transactionId,
        facilitator: input.patch.facilitator ?? current.facilitator,
        refusalCode: input.patch.refusalCode ?? current.refusalCode,
        errorCode: input.patch.errorCode === undefined ? current.errorCode : input.patch.errorCode,
        settledAt: input.patch.settledAt ?? current.settledAt,
        lastCheckedAt:
          input.from === 'SUBMITTED' || input.from === 'UNKNOWN' ? input.at : current.lastCheckedAt,
        updatedAt: input.at,
      });
      if (input.verification !== undefined) this.#insertVerification(input.verification);
      const res = this.#db
        .prepare(
          `UPDATE payment_intents SET status = ?, transaction_id = ?, facilitator = ?, refusal_code = ?,
             error_code = ?, settled_at = ?, last_checked_at = ?, updated_at = ?
           WHERE id = ? AND status = ?`,
        )
        .run(
          next.status,
          next.transactionId,
          next.facilitator,
          next.refusalCode,
          next.errorCode,
          next.settledAt,
          next.lastCheckedAt,
          next.updatedAt,
          input.id,
          input.from,
        );
      if (Number(res.changes) !== 1)
        throw new StaleTransitionError(input.id, input.from, current.status);
      this.#appendTransition({
        paymentId: input.id,
        from: input.from,
        to: input.to,
        detail: input.detail,
        at: input.at,
      });
      return next;
    });
  }

  async noteCheck(
    id: string,
    from: PaymentStatus,
    errorCode: string | null,
    at: string,
    verification?: SettlementVerification,
  ): Promise<PaymentIntent> {
    return this.#tx(() => {
      if (verification !== undefined) this.#insertVerification(verification);
      const res = this.#db
        .prepare(
          `UPDATE payment_intents SET reconcile_attempts = reconcile_attempts + 1, last_checked_at = ?,
             error_code = ?, updated_at = ? WHERE id = ? AND status = ?`,
        )
        .run(at, errorCode, at, id, from);
      const current = this.#get(id);
      if (Number(res.changes) !== 1 || current === null)
        throw new StaleTransitionError(id, from, current?.status ?? null);
      return current;
    });
  }

  async history(id: string): Promise<PaymentTransition[]> {
    const stmt = this.#db.prepare(
      'SELECT * FROM payment_transitions WHERE payment_id = ? ORDER BY seq',
    );
    return (stmt.all(id) as Row[]).map((r) => ({
      paymentId: String(r['payment_id']),
      seq: Number(r['seq']),
      from: (r['from_status'] ?? null) as PaymentStatus | null,
      to: r['to_status'] as PaymentStatus,
      detail: JSON.parse(String(r['detail'])) as Record<string, unknown>,
      at: String(r['at']),
    }));
  }

  async committed(input: {
    readonly runId: string;
    readonly dayStart: string;
    readonly dayEnd: string;
  }): Promise<CommittedSpend> {
    const statuses = COMMITTED_PAYMENT_STATUSES;
    const inList = placeholders(statuses.length);
    const sum = (rows: Row[]) =>
      rows.reduce((total, r) => total + BigInt(String(r['amount_atomic'])), 0n);
    const runRows = this.#db
      .prepare(
        `SELECT amount_atomic, provider, capability FROM payment_intents WHERE run_id = ? AND status IN (${inList})`,
      )
      .all(input.runId, ...statuses) as Row[];
    const dayRows = this.#db
      .prepare(
        `SELECT amount_atomic, pay_to FROM payment_intents WHERE created_at >= ? AND created_at < ? AND status IN (${inList})`,
      )
      .all(input.dayStart, input.dayEnd, ...statuses) as Row[];
    const dayByPayee: Record<string, bigint> = {};
    for (const r of dayRows) {
      const payee = String(r['pay_to']);
      dayByPayee[payee] = (dayByPayee[payee] ?? 0n) + BigInt(String(r['amount_atomic']));
    }
    const started = this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM payment_intents WHERE run_id = ? AND status NOT IN ('CREATED', 'REFUSED')",
      )
      .get(input.runId) as { n: number };
    return {
      run: sum(runRows),
      day: sum(dayRows),
      runPayments: Number(started.n),
      runPurchases: runRows.map((r) => ({
        provider: String(r['provider']),
        capability: String(r['capability']),
      })),
      dayByPayee,
    };
  }
}
