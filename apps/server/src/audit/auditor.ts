/**
 * The HCS auditor (plan row 29, D-057): after a run ends, post one message
 * per settled payment and one task digest to the agent's audit topic, then
 * confirm each on the Mirror Node by reading it back byte for byte.
 *
 * Safety, as for payments (D-042, D-044):
 *   - the row (payload, its SHA-256, the transaction ID) is written BEFORE the
 *     submit, and the database refuses a second live message for the same
 *     settlement or task (partial unique indexes, migration 8);
 *   - an ambiguous submit (timeout, lost connection) is UNKNOWN, never resent;
 *     the Mirror Node decides later from the recorded transaction ID;
 *   - only a definite failure (rejected at precheck, failed receipt, or the
 *     transaction ID never reached consensus before it expired) frees the slot
 *     for a new message;
 *   - CONFIRMED means the Mirror Node returned exactly the bytes recorded.
 * An audit failure never changes the run: it is reported, not raised.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InferenceCall, PaymentIntent } from '@agent-economy/core/domain';
import {
  toMirrorTransactionId,
  type MirrorTopicMessage,
  type MirrorTransaction,
} from '@agent-economy/hedera';
import { redactText } from '../api/redact.ts';
import { summarizeRun } from '../api/run-summary.ts';
import { getReport, getRun, listRunEvents } from '../db/repositories.ts';
import { encodeMessage, settlementMessage, sha256Hex, taskMessage } from './payloads.ts';

export const AUDIT_STATUSES = [
  'SUBMITTING',
  'SUBMITTED',
  'CONFIRMED',
  'UNKNOWN',
  'FAILED',
] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];
export const AUDIT_KINDS = ['settlement', 'task'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditMessage {
  readonly id: string;
  readonly runId: string;
  readonly kind: AuditKind;
  readonly paymentId: string | null;
  readonly topicId: string;
  readonly payload: string;
  readonly payloadSha256: string;
  readonly transactionId: string;
  readonly status: AuditStatus;
  readonly sequenceNumber: string | null;
  readonly consensusTimestamp: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A submit that certainly did not record a message (precheck or receipt failure). */
export class DefiniteSubmitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DefiniteSubmitError';
    this.code = code;
  }
}

/** Posts to the topic (the Hiero SDK in production, a fake in tests). */
export interface TopicPublisher {
  readonly topicId: string;
  /** A fresh transaction ID for the payer, recorded before the submit. */
  newTransactionId(): string;
  /**
   * Submit under that transaction ID. Throw DefiniteSubmitError when the
   * message was certainly not recorded; any other throw is ambiguous.
   */
  submit(input: {
    readonly message: Uint8Array;
    readonly transactionId: string;
  }): Promise<{ readonly sequenceNumber: string }>;
}

/** The Mirror Node reads the auditor needs. */
export interface AuditMirror {
  getTopicMessage(topicId: string, sequenceNumber: string): Promise<MirrorTopicMessage | null>;
  getTopicMessageAt(consensusTimestamp: string): Promise<MirrorTopicMessage | null>;
  getTransactions(mirrorTransactionId: string): Promise<MirrorTransaction[]>;
}

export interface AuditorDeps {
  readonly db: DatabaseSync;
  readonly publisher: TopicPublisher;
  readonly mirror: AuditMirror;
  readonly payments: {
    listByRun(runId: string): Promise<PaymentIntent[]>;
    verifications(
      paymentId: string,
    ): Promise<readonly { readonly outcome: string; readonly consensusTimestamp: string | null }[]>;
  };
  readonly inference: { listCalls(filter: { runId: string }): Promise<InferenceCall[]> };
  /** The ENS parent, named in each message as the agent. */
  readonly agent: string;
  readonly mode: 'live' | 'mock';
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Mirror Node read-back: attempts and delay between them (it lags consensus by seconds). */
  readonly confirmAttempts?: number;
  readonly confirmDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

/** Hedera transaction IDs older than this (valid start + 180 s, with margin) can no longer reach consensus. */
const EXPIRY_MS = 4 * 60_000;

type Row = Record<string, unknown>;
type MaybeRow = Row | undefined;
const messageFromRow = (r: Row): AuditMessage => ({
  id: String(r['id']),
  runId: String(r['run_id']),
  kind: r['kind'] as AuditKind,
  paymentId: typeof r['payment_id'] === 'string' ? r['payment_id'] : null,
  topicId: String(r['topic_id']),
  payload: String(r['payload']),
  payloadSha256: String(r['payload_sha256']),
  transactionId: String(r['transaction_id']),
  status: r['status'] as AuditStatus,
  sequenceNumber: typeof r['sequence_number'] === 'string' ? r['sequence_number'] : null,
  consensusTimestamp:
    typeof r['consensus_timestamp'] === 'string' ? r['consensus_timestamp'] : null,
  error: typeof r['error'] === 'string' ? r['error'] : null,
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
});

/** Every audit message of a run, oldest first. */
export function auditMessagesOf(db: DatabaseSync, runId: string): AuditMessage[] {
  return (
    db
      .prepare('SELECT * FROM hcs_messages WHERE run_id = ? ORDER BY created_at, rowid')
      .all(runId) as Row[]
  ).map(messageFromRow);
}

/** Valid start of a transaction ID "0.0.N@seconds.nanos", in ms. */
const validStartMs = (transactionId: string): number | null => {
  const m = /@(\d+)\.(\d+)$/.exec(transactionId);
  return m === null ? null : Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1e6);
};

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export interface AuditOutcome {
  readonly posted: number;
  readonly confirmed: number;
  readonly pending: number;
  readonly failed: number;
}

export class Auditor {
  readonly #d: AuditorDeps;

  constructor(deps: AuditorDeps) {
    this.#d = deps;
  }

  get topicId(): string {
    return this.#d.publisher.topicId;
  }

  #now(): string {
    return (this.#d.now ?? (() => new Date()))().toISOString();
  }

  #set(
    id: string,
    fields: Partial<
      Record<'status' | 'sequence_number' | 'consensus_timestamp' | 'error', string | null>
    >,
  ) {
    const keys = Object.keys(fields);
    this.#d.db
      .prepare(
        `UPDATE hcs_messages SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      )
      .run(...keys.map((k) => fields[k as keyof typeof fields] ?? null), this.#now(), id);
  }

  #get(id: string): AuditMessage {
    const row = this.#d.db.prepare('SELECT * FROM hcs_messages WHERE id = ?').get(id) as MaybeRow;
    if (row === undefined) throw new Error(`audit message ${id} not found`);
    return messageFromRow(row);
  }

  /** Has this settlement or task a message that is not definitely failed? */
  #live(kind: AuditKind, runId: string, paymentId: string | null): boolean {
    const row =
      kind === 'settlement'
        ? this.#d.db
            .prepare(
              "SELECT 1 FROM hcs_messages WHERE kind = 'settlement' AND payment_id = ? AND status <> 'FAILED'",
            )
            .get(paymentId)
        : this.#d.db
            .prepare(
              "SELECT 1 FROM hcs_messages WHERE kind = 'task' AND run_id = ? AND status <> 'FAILED'",
            )
            .get(runId);
    return row !== undefined;
  }

  /** Record, then submit, one message. Never throws for a submit problem. */
  async #post(
    kind: AuditKind,
    runId: string,
    paymentId: string | null,
    message: Record<string, unknown>,
  ) {
    let encoded: ReturnType<typeof encodeMessage>;
    try {
      encoded = encodeMessage(message);
    } catch (error) {
      this.#d.log?.(
        `audit ${kind} for ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const id = (this.#d.newId ?? randomUUID)();
    const transactionId = this.#d.publisher.newTransactionId();
    const at = this.#now();
    try {
      this.#d.db
        .prepare(
          `INSERT INTO hcs_messages (id, run_id, kind, payment_id, topic_id, payload, payload_sha256, transaction_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTING', ?, ?)`,
        )
        .run(
          id,
          runId,
          kind,
          paymentId,
          this.topicId,
          encoded.text,
          encoded.sha256,
          transactionId,
          at,
          at,
        );
    } catch (error) {
      // another process recorded it first (unique index): nothing to do
      this.#d.log?.(
        `audit ${kind} for ${runId} not recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    try {
      const { sequenceNumber } = await this.#d.publisher.submit({
        message: encoded.bytes,
        transactionId,
      });
      this.#set(id, { status: 'SUBMITTED', sequence_number: sequenceNumber });
    } catch (error) {
      const text = redactText(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ).slice(0, 250);
      if (error instanceof DefiniteSubmitError)
        this.#set(id, { status: 'FAILED', error: `${error.code}: ${text}` });
      else this.#set(id, { status: 'UNKNOWN', error: `SUBMIT_OUTCOME_UNKNOWN: ${text}` });
    }
  }

  /**
   * Read a submitted message back from the Mirror Node: CONFIRMED only if the
   * bytes are exactly the recorded payload.
   */
  async #confirm(m: AuditMessage): Promise<void> {
    if (m.status !== 'SUBMITTED' || m.sequenceNumber === null) return;
    const attempts = this.#d.confirmAttempts ?? 10;
    const delay = this.#d.confirmDelayMs ?? 2_000;
    const sleep = this.#d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < attempts; i++) {
      const found = await this.#d.mirror.getTopicMessage(m.topicId, m.sequenceNumber);
      if (found !== null) {
        if (sameBytes(found.message, new TextEncoder().encode(m.payload)))
          this.#set(m.id, {
            status: 'CONFIRMED',
            consensus_timestamp: found.consensusTimestamp,
            error: null,
          });
        else
          this.#set(m.id, {
            status: 'UNKNOWN',
            error: `MIRROR_MISMATCH: message #${m.sequenceNumber} on the Mirror Node is not the recorded payload`,
          });
        return;
      }
      if (i < attempts - 1) await sleep(delay);
    }
  }

  /** Decide an UNKNOWN submit from its transaction ID on the Mirror Node (never by resending). */
  async #reconcile(m: AuditMessage): Promise<void> {
    if (m.status !== 'UNKNOWN' || (m.error ?? '').startsWith('MIRROR_MISMATCH')) return;
    const entries = await this.#d.mirror.getTransactions(toMirrorTransactionId(m.transactionId));
    const ok = entries.find((e) => e.result === 'SUCCESS');
    if (ok !== undefined) {
      const found = await this.#d.mirror.getTopicMessageAt(ok.consensusTimestamp);
      if (
        found !== null &&
        found.topicId === m.topicId &&
        sameBytes(found.message, new TextEncoder().encode(m.payload))
      ) {
        this.#d.db
          .prepare(
            "UPDATE hcs_messages SET status = 'CONFIRMED', sequence_number = ?, consensus_timestamp = ?, error = NULL, updated_at = ? WHERE id = ?",
          )
          .run(found.sequenceNumber, found.consensusTimestamp, this.#now(), m.id);
      }
      return;
    }
    if (entries.length > 0) {
      this.#set(m.id, {
        status: 'FAILED',
        error: `TX_FAILED: ${entries.map((e) => e.result).join(', ')}`,
      });
      return;
    }
    const start = validStartMs(m.transactionId);
    const nowMs = Date.parse(this.#now());
    if (start !== null && nowMs - start > EXPIRY_MS)
      this.#set(m.id, { status: 'FAILED', error: 'TX_EXPIRED_NOT_FOUND: never reached consensus' });
  }

  /** Post the run's settlement messages and its digest, then confirm them. */
  async auditRun(runId: string): Promise<AuditOutcome> {
    const run = getRun(this.#d.db, runId);
    if (run === null || run.status === 'QUEUED' || run.status === 'RUNNING')
      return { posted: 0, confirmed: 0, pending: 0, failed: 0 };
    const before = auditMessagesOf(this.#d.db, runId).length;
    const payments = await this.#d.payments.listByRun(runId);
    for (const p of payments) {
      if (p.status !== 'SETTLED' || p.transactionId === null) continue;
      if (this.#live('settlement', runId, p.id)) continue;
      const v = (await this.#d.payments.verifications(p.id)).findLast(
        (x) => x.outcome === 'SETTLED',
      );
      await this.#post(
        'settlement',
        runId,
        p.id,
        settlementMessage({
          agent: this.#d.agent,
          runId,
          paymentId: p.id,
          provider: p.provider,
          payTo: p.payTo,
          amountAtomic: p.amountAtomic,
          asset: p.asset,
          network: p.network,
          transactionId: p.transactionId,
          consensusTimestamp: v?.consensusTimestamp ?? null,
        }),
      );
    }
    if (!this.#live('task', runId, null)) {
      const events = listRunEvents(this.#d.db, runId);
      const started = events.find((e) => e.type === 'RUN_STARTED')?.payload ?? {};
      const policy = (started['policy'] ?? {}) as Record<string, unknown>;
      const discovered = events.find((e) => e.type === 'PROVIDERS_DISCOVERED')?.payload ?? {};
      const report = getReport(this.#d.db, runId);
      const calls = await this.#d.inference.listCalls({ runId });
      await this.#post(
        'task',
        runId,
        null,
        taskMessage({
          agent: this.#d.agent,
          runId,
          trigger: run.trigger,
          status: run.status,
          verdict: summarizeRun(events, run.status, this.#d.mode).verdict,
          finishedAt: run.finishedAt,
          ensBlock:
            typeof discovered['blockNumber'] === 'string' ? discovered['blockNumber'] : null,
          policyVersion: typeof policy['version'] === 'number' ? policy['version'] : null,
          reportSha256: report === null ? null : sha256Hex(report.markdown),
          settled: payments
            .filter((p) => p.status === 'SETTLED' && p.transactionId !== null)
            .map((p) => p.transactionId as string),
          refused: payments.filter((p) => p.status === 'REFUSED').length,
          inference: calls.map((c) => ({
            purpose: c.purpose,
            requestId: c.requestId,
            costNeuron: c.costNeuron,
          })),
        }),
      );
    }
    for (const m of auditMessagesOf(this.#d.db, runId)) await this.#confirm(m);
    const after = auditMessagesOf(this.#d.db, runId);
    return {
      posted: after.length - before,
      confirmed: after.filter((m) => m.status === 'CONFIRMED').length,
      pending: after.filter(
        (m) => m.status === 'SUBMITTED' || m.status === 'UNKNOWN' || m.status === 'SUBMITTING',
      ).length,
      failed: after.filter((m) => m.status === 'FAILED').length,
    };
  }

  /**
   * Settle what earlier processes left open: confirm SUBMITTED messages,
   * decide UNKNOWN ones from the Mirror Node, and mark SUBMITTING rows (a crash
   * between record and submit) UNKNOWN so they are decided the same way.
   */
  async reconcile(): Promise<void> {
    const open = (
      this.#d.db
        .prepare(
          "SELECT * FROM hcs_messages WHERE status IN ('SUBMITTING','SUBMITTED','UNKNOWN') ORDER BY created_at",
        )
        .all() as Row[]
    ).map(messageFromRow);
    for (const m of open) {
      try {
        if (m.status === 'SUBMITTING') {
          // a submit in flight in this process is recent; only an old row was interrupted
          if (Date.parse(this.#now()) - Date.parse(m.createdAt) < 120_000) continue;
          this.#set(m.id, {
            status: 'UNKNOWN',
            error: 'SUBMIT_INTERRUPTED: the process stopped during the submit',
          });
          await this.#reconcile(this.#get(m.id));
        } else if (m.status === 'SUBMITTED') await this.#confirm(m);
        else await this.#reconcile(m);
      } catch (error) {
        this.#d.log?.(
          `audit reconcile ${m.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
