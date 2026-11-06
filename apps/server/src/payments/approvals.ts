/**
 * Payment approvals (D-066): in Human approval mode, a payment the firewall
 * allowed waits here for the owner before anything is signed.
 *
 *   request   a PENDING row, written before the wait (the payment intent is
 *             AUTHORIZED, so its amount already counts as committed spend)
 *   decide    the owner approves or rejects, once, through the API (access code)
 *   expire    nobody answered in time, or the server is stopping or restarting
 *
 * The database enforces the rest (migration 9): a row is born PENDING, is
 * decided once, and what it asked for never changes. Deciding is a
 * conditional UPDATE (`WHERE status = 'PENDING'`), so two tabs, or a decision
 * racing the timeout, cannot both win. A rejected or expired approval ends the
 * payment as FAILED before it was ever signed (AUTHORIZED → FAILED).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type ApprovalDecider = 'owner' | 'timeout' | 'restart';

export interface PaymentApproval {
  readonly id: string;
  readonly runId: string;
  readonly paymentId: string;
  readonly provider: string;
  readonly capability: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly requestUrl: string;
  /** The approval threshold in force when it was asked (tinybars). */
  readonly threshold: string;
  readonly status: ApprovalStatus;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: ApprovalDecider | null;
  readonly note: string | null;
}

export interface ApprovalRequest {
  readonly runId: string;
  readonly paymentId: string;
  readonly provider: string;
  readonly capability: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly requestUrl: string;
  readonly threshold: bigint;
}

export class ApprovalError extends Error {
  readonly code: 'NOT_FOUND' | 'ALREADY_DECIDED' | 'EXPIRED';
  constructor(code: ApprovalError['code'], message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

/** How long the owner has to answer, by default (APPROVAL_TIMEOUT_SEC). */
export const DEFAULT_APPROVAL_TIMEOUT_SEC = 600;
const MAX_NOTE = 200;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const fromRow = (r: Row): PaymentApproval => ({
  id: String(r['id']),
  runId: String(r['run_id']),
  paymentId: String(r['payment_id']),
  provider: String(r['provider']),
  capability: String(r['capability']),
  payTo: String(r['pay_to']),
  amountAtomic: String(r['amount_atomic']),
  requestUrl: String(r['request_url']),
  threshold: String(r['threshold']),
  status: String(r['status']) as ApprovalStatus,
  requestedAt: String(r['requested_at']),
  expiresAt: String(r['expires_at']),
  decidedAt: str(r['decided_at']),
  decidedBy: str(r['decided_by']) as ApprovalDecider | null,
  note: str(r['note']),
});

export interface ApprovalStoreOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Seconds the owner has to answer a request. */
  readonly timeoutSec?: number;
}

export class ApprovalStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly timeoutSec: number;

  constructor(db: DatabaseSync, options: ApprovalStoreOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    const t = options.timeoutSec ?? DEFAULT_APPROVAL_TIMEOUT_SEC;
    if (!Number.isInteger(t) || t < 30 || t > 3600)
      throw new RangeError('the approval timeout must be 30 to 3600 seconds');
    this.timeoutSec = t;
  }

  /** Record a PENDING request. One per payment (the database refuses a second). */
  request(input: ApprovalRequest): PaymentApproval {
    const now = this.#now();
    const id = this.#newId();
    this.#db
      .prepare(
        `INSERT INTO payment_approvals (id, run_id, payment_id, provider, capability, pay_to, amount_atomic, request_url, threshold, status, requested_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(
        id,
        input.runId,
        input.paymentId,
        input.provider,
        input.capability,
        input.payTo,
        input.amountAtomic,
        input.requestUrl,
        input.threshold.toString(),
        now.toISOString(),
        new Date(now.getTime() + this.timeoutSec * 1000).toISOString(),
      );
    const saved = this.get(id);
    if (saved === null) throw new Error('approval request was not saved');
    return saved;
  }

  get(id: string): PaymentApproval | null {
    const r = this.#db.prepare('SELECT * FROM payment_approvals WHERE id = ?').get(id) as
      Row | undefined;
    return r === undefined ? null : fromRow(r);
  }

  /** Newest first; optionally only one status. */
  list(filter: { readonly status?: ApprovalStatus; readonly limit?: number } = {}) {
    const n = Math.max(1, Math.min(filter.limit ?? 20, 100));
    const rows = (
      filter.status === undefined
        ? this.#db
            .prepare('SELECT * FROM payment_approvals ORDER BY requested_at DESC LIMIT ?')
            .all(n)
        : this.#db
            .prepare(
              'SELECT * FROM payment_approvals WHERE status = ? ORDER BY requested_at DESC LIMIT ?',
            )
            .all(filter.status, n)
    ) as Row[];
    return rows.map(fromRow);
  }

  listByRun(runId: string): PaymentApproval[] {
    return (
      this.#db
        .prepare('SELECT * FROM payment_approvals WHERE run_id = ? ORDER BY requested_at')
        .all(runId) as Row[]
    ).map(fromRow);
  }

  /**
   * The owner's answer. Throws ApprovalError when the request does not exist,
   * was already decided, or ran out of time (it is then marked EXPIRED).
   */
  decide(id: string, decision: 'APPROVED' | 'REJECTED', note: string | null = null) {
    const current = this.get(id);
    if (current === null) throw new ApprovalError('NOT_FOUND', `no approval request ${id}`);
    if (current.status !== 'PENDING')
      throw new ApprovalError(
        'ALREADY_DECIDED',
        `this request was already decided: ${current.status.toLowerCase()}`,
      );
    const now = this.#now().toISOString();
    if (now >= current.expiresAt) {
      this.expire(id, 'timeout');
      throw new ApprovalError('EXPIRED', 'the time to answer this request has passed');
    }
    const text = note === null ? null : note.trim().slice(0, MAX_NOTE);
    const changed = this.#db
      .prepare(
        `UPDATE payment_approvals SET status = ?, decided_at = ?, decided_by = 'owner', note = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(decision, now, text === '' ? null : text, id);
    if (Number(changed.changes) !== 1)
      throw new ApprovalError('ALREADY_DECIDED', 'this request was decided at the same moment');
    return this.get(id) as PaymentApproval;
  }

  /** Mark a PENDING request EXPIRED; returns it, or null if it was already decided. */
  expire(id: string, by: 'timeout' | 'restart'): PaymentApproval | null {
    const changed = this.#db
      .prepare(
        `UPDATE payment_approvals SET status = 'EXPIRED', decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(this.#now().toISOString(), by, id);
    return Number(changed.changes) === 1 ? this.get(id) : null;
  }

  /** Expire every PENDING request (the server is stopping, or starting after a crash). */
  expireAllPending(by: 'restart'): PaymentApproval[] {
    const out: PaymentApproval[] = [];
    for (const a of this.list({ status: 'PENDING', limit: 100 })) {
      const e = this.expire(a.id, by);
      if (e !== null) out.push(e);
    }
    return out;
  }

  /**
   * Wait until the request is decided or its time runs out (then it is
   * EXPIRED by 'timeout'). Polls the database: the decision arrives through
   * another request (the API), possibly after a restart of nothing else.
   */
  async wait(
    id: string,
    options: { readonly pollMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<PaymentApproval> {
    const pollMs = options.pollMs ?? 1000;
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (;;) {
      const a = this.get(id);
      if (a === null) throw new ApprovalError('NOT_FOUND', `no approval request ${id}`);
      if (a.status !== 'PENDING') return a;
      if (this.#now().toISOString() >= a.expiresAt) {
        const expired = this.expire(id, 'timeout');
        return expired ?? (this.get(id) as PaymentApproval);
      }
      await sleep(pollMs);
    }
  }
}
