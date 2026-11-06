/**
 * Inference ledger (plan row 18, D-040): one `inference_calls` row per 0G
 * call, a daily cap enforced by reservation, and Router balance snapshots.
 *
 * Callers depend on the async `InferenceLedger` interface (D-031), so the
 * Render deployment can add a Postgres implementation behind it. The SQLite
 * implementation below is the reference: the reservation (sum today's
 * charges, check the cap, insert the PENDING row) runs in one IMMEDIATE
 * transaction, so two concurrent calls cannot both squeeze under the cap.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  INFERENCE_TRANSITIONS,
  InferenceCall,
  ZgBalanceSnapshot,
  type InferenceStatus,
} from '@agent-economy/core/domain';
import { checkDailyCap, chargeOf, utcDay, utcDayBounds } from '@agent-economy/zg';

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

type Purpose = InferenceCall['purpose'];
type Network = InferenceCall['network'];

export interface ReserveInput {
  readonly id: string;
  readonly runId: string | null;
  readonly purpose: Purpose;
  readonly network: Network;
  readonly model: string;
  readonly worstCaseNeuron: bigint;
  readonly dailyCapNeuron: bigint;
  readonly at: string;
}

export type Reservation =
  | {
      readonly ok: true;
      readonly call: InferenceCall;
      readonly spentBefore: bigint;
      readonly remainingAfter: bigint;
    }
  | {
      readonly ok: false;
      readonly code: 'DAILY_CAP_EXCEEDED';
      readonly reason: string;
      /** The REFUSED row recorded for the attempt. */
      readonly call: InferenceCall;
      readonly spentBefore: bigint;
    };

export interface RefusalInput {
  readonly id: string;
  readonly runId: string | null;
  readonly purpose: Purpose;
  readonly network: Network;
  readonly model: string;
  readonly errorCode: string;
  readonly worstCaseNeuron: bigint | null;
  readonly at: string;
}

export interface Billing {
  readonly requestId: string;
  readonly provider: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costNeuron: bigint;
  readonly teeVerified: boolean | null;
}

export type SettleOutcome =
  /** Billed and usable. */
  | ({ readonly status: 'SUCCEEDED' } & Billing)
  /** Billed but unusable (e.g. output failed the schema): the cost still counts. */
  | ({ readonly status: 'FAILED'; readonly errorCode: string } & Billing)
  /** Router error response: not billed (reconciliation would flag it if it were). */
  | { readonly status: 'FAILED'; readonly errorCode: string; readonly requestId: string | null }
  /** Transport error or timeout: outcome unknown, still counted at the worst case. */
  | { readonly status: 'UNKNOWN'; readonly errorCode: string };

export interface FundingSplit {
  readonly creditUsedNeuron: bigint;
  readonly depositUsedNeuron: bigint;
  readonly funding: 'credits' | 'deposit' | 'mixed' | 'none';
}

export interface DaySpend {
  readonly day: string;
  readonly spent: bigint;
  readonly calls: number;
  readonly byStatus: Readonly<Record<InferenceStatus, number>>;
}

export interface CallFilter {
  readonly from?: string;
  readonly to?: string;
  readonly runId?: string;
}

export interface InferenceLedger {
  /** Check the daily cap and reserve the worst case (PENDING), or record a REFUSED row. */
  reserve(input: ReserveInput): Promise<Reservation>;
  /** Record a refusal that happened before reservation (per-call cap, catalog, capability). */
  recordRefusal(input: RefusalInput): Promise<InferenceCall>;
  /** Settle a PENDING (or UNKNOWN) call with what the Router reported. */
  settle(id: string, outcome: SettleOutcome, at: string): Promise<InferenceCall>;
  /** Store the funding split from the Router's usage history. */
  reconcile(id: string, funding: FundingSplit, at: string): Promise<InferenceCall>;
  spentOnDay(day: string): Promise<DaySpend>;
  listCalls(filter?: CallFilter): Promise<InferenceCall[]>;
  getCall(id: string): Promise<InferenceCall | null>;
  recordBalanceSnapshot(snapshot: ZgBalanceSnapshot): Promise<ZgBalanceSnapshot>;
  listBalanceSnapshots(limit: number): Promise<ZgBalanceSnapshot[]>;
}

// ── SQLite implementation ─────────────────────────────────────────────────

type Row = Record<string, unknown>;
type MaybeRow = Row | undefined;

const STATUSES: readonly InferenceStatus[] = [
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'REFUSED',
];

const big = (v: unknown): bigint | null => (typeof v === 'string' ? BigInt(v) : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function callFromRow(r: Row): InferenceCall {
  return InferenceCall.parse({
    id: r['id'],
    runId: r['run_id'],
    purpose: r['purpose'],
    network: r['network'],
    model: r['model'],
    status: r['status'],
    requestId: r['request_id'],
    provider: r['provider'],
    promptTokens: num(r['prompt_tokens']),
    completionTokens: num(r['completion_tokens']),
    worstCaseNeuron: r['worst_case_neuron'],
    costNeuron: r['cost_neuron'],
    creditUsedNeuron: r['credit_used_neuron'],
    depositUsedNeuron: r['deposit_used_neuron'],
    funding: r['funding'],
    teeVerified: r['tee_verified'] === null ? null : Number(r['tee_verified']) === 1,
    errorCode: r['error_code'],
    createdAt: r['created_at'],
    settledAt: r['settled_at'],
    reconciledAt: r['reconciled_at'],
  });
}

function snapshotFromRow(r: Row): ZgBalanceSnapshot {
  return ZgBalanceSnapshot.parse({
    id: r['id'],
    network: r['network'],
    address: r['address'],
    depositBalanceNeuron: r['deposit_balance_neuron'],
    creditBalanceNeuron: r['credit_balance_neuron'],
    pendingChargeNeuron: r['pending_charge_neuron'],
    totalBalanceNeuron: r['total_balance_neuron'],
    balanceNeuron: r['balance_neuron'],
    trigger: r['trigger'],
    takenAt: r['taken_at'],
  });
}

export class SqliteInferenceLedger implements InferenceLedger {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #transaction<T>(fn: () => T): T {
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

  #insert(c: InferenceCall): InferenceCall {
    const call = InferenceCall.parse(c);
    this.#db
      .prepare(
        `INSERT INTO inference_calls (id, run_id, purpose, network, model, status, request_id, provider,
           prompt_tokens, completion_tokens, worst_case_neuron, cost_neuron, credit_used_neuron,
           deposit_used_neuron, funding, tee_verified, error_code, created_at, settled_at, reconciled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.id,
        call.runId,
        call.purpose,
        call.network,
        call.model,
        call.status,
        call.requestId,
        call.provider,
        call.promptTokens,
        call.completionTokens,
        call.worstCaseNeuron,
        call.costNeuron,
        call.creditUsedNeuron,
        call.depositUsedNeuron,
        call.funding,
        call.teeVerified === null ? null : call.teeVerified ? 1 : 0,
        call.errorCode,
        call.createdAt,
        call.settledAt,
        call.reconciledAt,
      );
    return call;
  }

  #daySpendSync(day: string): DaySpend {
    const { start, end } = utcDayBounds(day);
    const rows = this.#db
      .prepare(
        'SELECT status, worst_case_neuron, cost_neuron FROM inference_calls WHERE created_at >= ? AND created_at < ?',
      )
      .all(start, end) as Row[];
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
      InferenceStatus,
      number
    >;
    let spent = 0n;
    for (const r of rows) {
      const status = r['status'] as InferenceStatus;
      byStatus[status] += 1;
      spent += chargeOf({
        status,
        worstCaseNeuron: big(r['worst_case_neuron']),
        costNeuron: big(r['cost_neuron']),
      });
    }
    return { day, spent, calls: rows.length, byStatus };
  }

  #getSync(id: string): InferenceCall | null {
    const stmt = this.#db.prepare('SELECT * FROM inference_calls WHERE id = ?');
    const row = stmt.get(id) as MaybeRow;
    return row === undefined ? null : callFromRow(row);
  }

  async reserve(input: ReserveInput): Promise<Reservation> {
    if (input.worstCaseNeuron <= 0n) throw new LedgerError('worst case must be positive');
    return this.#transaction(() => {
      const spent = this.#daySpendSync(utcDay(input.at)).spent;
      const decision = checkDailyCap({
        spent,
        worstCase: input.worstCaseNeuron,
        dailyCap: input.dailyCapNeuron,
      });
      const base = {
        id: input.id,
        runId: input.runId,
        purpose: input.purpose,
        network: input.network,
        model: input.model,
        requestId: null,
        provider: null,
        promptTokens: null,
        completionTokens: null,
        worstCaseNeuron: input.worstCaseNeuron.toString(),
        costNeuron: null,
        creditUsedNeuron: null,
        depositUsedNeuron: null,
        teeVerified: null,
        createdAt: input.at,
        reconciledAt: null,
      };
      if (!decision.ok) {
        const call = this.#insert({
          ...base,
          status: 'REFUSED',
          funding: 'none',
          errorCode: decision.code,
          settledAt: input.at,
        });
        return {
          ok: false,
          code: decision.code,
          reason: decision.reason,
          call,
          spentBefore: spent,
        };
      }
      const call = this.#insert({
        ...base,
        status: 'PENDING',
        funding: 'unknown',
        errorCode: null,
        settledAt: null,
      });
      return { ok: true, call, spentBefore: spent, remainingAfter: decision.remainingAfter };
    });
  }

  async recordRefusal(input: RefusalInput): Promise<InferenceCall> {
    return this.#insert({
      id: input.id,
      runId: input.runId,
      purpose: input.purpose,
      network: input.network,
      model: input.model,
      status: 'REFUSED',
      requestId: null,
      provider: null,
      promptTokens: null,
      completionTokens: null,
      worstCaseNeuron: input.worstCaseNeuron?.toString() ?? null,
      costNeuron: null,
      creditUsedNeuron: null,
      depositUsedNeuron: null,
      funding: 'none',
      teeVerified: null,
      errorCode: input.errorCode,
      createdAt: input.at,
      settledAt: input.at,
      reconciledAt: null,
    });
  }

  async settle(id: string, outcome: SettleOutcome, at: string): Promise<InferenceCall> {
    return this.#transaction(() => {
      const current = this.#getSync(id);
      if (current === null) throw new LedgerError(`inference call ${id} does not exist`);
      if (!INFERENCE_TRANSITIONS[current.status].includes(outcome.status)) {
        throw new LedgerError(`illegal inference transition ${current.status} → ${outcome.status}`);
      }
      const billed = 'costNeuron' in outcome;
      const next = InferenceCall.parse({
        ...current,
        status: outcome.status,
        requestId: billed
          ? outcome.requestId
          : 'requestId' in outcome
            ? outcome.requestId
            : current.requestId,
        provider: billed ? outcome.provider : current.provider,
        promptTokens: billed ? outcome.promptTokens : current.promptTokens,
        completionTokens: billed ? outcome.completionTokens : current.completionTokens,
        costNeuron: billed ? outcome.costNeuron.toString() : current.costNeuron,
        teeVerified: billed ? outcome.teeVerified : current.teeVerified,
        errorCode: 'errorCode' in outcome ? outcome.errorCode : null,
        settledAt: at,
      });
      this.#db
        .prepare(
          `UPDATE inference_calls SET status = ?, request_id = ?, provider = ?, prompt_tokens = ?,
             completion_tokens = ?, cost_neuron = ?, tee_verified = ?, error_code = ?, settled_at = ?
           WHERE id = ?`,
        )
        .run(
          next.status,
          next.requestId,
          next.provider,
          next.promptTokens,
          next.completionTokens,
          next.costNeuron,
          next.teeVerified === null ? null : next.teeVerified ? 1 : 0,
          next.errorCode,
          next.settledAt,
          id,
        );
      return next;
    });
  }

  async reconcile(id: string, funding: FundingSplit, at: string): Promise<InferenceCall> {
    return this.#transaction(() => {
      const current = this.#getSync(id);
      if (current === null) throw new LedgerError(`inference call ${id} does not exist`);
      if (current.costNeuron === null)
        throw new LedgerError(`inference call ${id} has no billed cost to reconcile`);
      const next = InferenceCall.parse({
        ...current,
        creditUsedNeuron: funding.creditUsedNeuron.toString(),
        depositUsedNeuron: funding.depositUsedNeuron.toString(),
        funding: funding.funding,
        reconciledAt: at,
      });
      this.#db
        .prepare(
          `UPDATE inference_calls SET credit_used_neuron = ?, deposit_used_neuron = ?, funding = ?, reconciled_at = ?
           WHERE id = ?`,
        )
        .run(next.creditUsedNeuron, next.depositUsedNeuron, next.funding, next.reconciledAt, id);
      return next;
    });
  }

  async spentOnDay(day: string): Promise<DaySpend> {
    return this.#daySpendSync(day);
  }

  async listCalls(filter: CallFilter = {}): Promise<InferenceCall[]> {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.from !== undefined) {
      where.push('created_at >= ?');
      args.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push('created_at < ?');
      args.push(filter.to);
    }
    if (filter.runId !== undefined) {
      where.push('run_id = ?');
      args.push(filter.runId);
    }
    const sql = `SELECT * FROM inference_calls${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY created_at, id`;
    return (this.#db.prepare(sql).all(...args) as Row[]).map(callFromRow);
  }

  async getCall(id: string): Promise<InferenceCall | null> {
    return this.#getSync(id);
  }

  /**
   * Attach a voice transcription (recorded before its task existed) to the run
   * it started (D-076). Only a SUCCEEDED (or UNKNOWN) TRANSCRIBE call with no run
   * yet; the database refuses a second attachment. False when it does not apply.
   */
  async attachToRun(id: string, runId: string): Promise<boolean> {
    const r = this.#db
      .prepare(
        `UPDATE inference_calls SET run_id = ?
         WHERE id = ? AND purpose = 'TRANSCRIBE' AND status IN ('SUCCEEDED','UNKNOWN') AND run_id IS NULL`,
      )
      .run(runId, id);
    return Number(r.changes) === 1;
  }

  async recordBalanceSnapshot(snapshot: ZgBalanceSnapshot): Promise<ZgBalanceSnapshot> {
    const s = ZgBalanceSnapshot.parse(snapshot);
    this.#db
      .prepare(
        `INSERT INTO zg_balance_snapshots (id, network, address, deposit_balance_neuron, credit_balance_neuron,
           pending_charge_neuron, total_balance_neuron, balance_neuron, trigger, taken_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.network,
        s.address,
        s.depositBalanceNeuron,
        s.creditBalanceNeuron,
        s.pendingChargeNeuron,
        s.totalBalanceNeuron,
        s.balanceNeuron,
        s.trigger,
        s.takenAt,
      );
    return s;
  }

  async listBalanceSnapshots(limit: number): Promise<ZgBalanceSnapshot[]> {
    const n = Math.max(1, Math.min(Math.trunc(limit), 1000));
    return (
      this.#db
        .prepare('SELECT * FROM zg_balance_snapshots ORDER BY taken_at DESC, id DESC LIMIT ?')
        .all(n) as Row[]
    ).map(snapshotFromRow);
  }
}
