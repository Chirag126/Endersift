/**
 * Persisted watchlist schedules (plan row 28, D-056). A schedule says: brief
 * this watchlist once per UTC day, after this time, within this budget.
 * `schedule_runs` is the claim: one row per schedule per UTC day, so a
 * restart, a second process or a slow tick can never start a second run on
 * the same day (the primary key refuses it).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface Schedule {
  readonly id: string;
  readonly watchlist: readonly string[];
  /** This schedule's per-run budget (tinybars); never above the run budget in force. */
  readonly budget: bigint;
  /** Minutes after 00:00 UTC before which the day's run does not start. */
  readonly runAfterMinute: number;
  readonly enabled: boolean;
  /** The latest reason a due run could not start (kill switch, budget, queue), or null. */
  readonly lastSkip: string | null;
  readonly lastSkipAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleRun {
  readonly scheduleId: string;
  /** UTC date, YYYY-MM-DD. */
  readonly day: string;
  readonly runId: string;
  readonly createdAt: string;
}

export const MAX_SCHEDULES = 5;

export class ScheduleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

type Row = Record<string, unknown>;
type MaybeRow = Row | undefined;

const scheduleFromRow = (r: Row): Schedule => ({
  id: String(r['id']),
  watchlist: JSON.parse(String(r['watchlist'])) as string[],
  budget: BigInt(String(r['budget'])),
  runAfterMinute: Number(r['run_after_minute']),
  enabled: Number(r['enabled']) === 1,
  lastSkip: typeof r['last_skip'] === 'string' ? r['last_skip'] : null,
  lastSkipAt: typeof r['last_skip_at'] === 'string' ? r['last_skip_at'] : null,
  createdAt: String(r['created_at']),
  updatedAt: String(r['updated_at']),
});

const runFromRow = (r: Row): ScheduleRun => ({
  scheduleId: String(r['schedule_id']),
  day: String(r['day']),
  runId: String(r['run_id']),
  createdAt: String(r['created_at']),
});

/** "HH:MM" (UTC) → minutes after midnight, or null. Pure. */
export function parseRunAfter(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  return m === null ? null : Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes after midnight → "HH:MM". Pure. */
export const formatRunAfter = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export interface ScheduleInput {
  readonly watchlist: readonly string[];
  readonly budget: bigint;
  readonly runAfterMinute: number;
  readonly enabled: boolean;
}

export class ScheduleStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(
    db: DatabaseSync,
    o: { readonly now?: () => Date; readonly newId?: () => string } = {},
  ) {
    this.#db = db;
    this.#now = o.now ?? (() => new Date());
    this.#newId = o.newId ?? randomUUID;
  }

  list(): Schedule[] {
    return (this.#db.prepare('SELECT * FROM schedules ORDER BY created_at').all() as Row[]).map(
      scheduleFromRow,
    );
  }

  get(id: string): Schedule | null {
    const row = this.#db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as MaybeRow;
    return row === undefined ? null : scheduleFromRow(row);
  }

  create(input: ScheduleInput): Schedule {
    if (this.list().length >= MAX_SCHEDULES)
      throw new ScheduleError('TOO_MANY_SCHEDULES', `at most ${MAX_SCHEDULES} schedules`);
    const id = this.#newId();
    const at = this.#now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO schedules (id, watchlist, budget, run_after_minute, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify(input.watchlist),
        input.budget.toString(),
        input.runAfterMinute,
        input.enabled ? 1 : 0,
        at,
        at,
      );
    const created = this.get(id);
    if (created === null) throw new Error('schedule was not saved');
    return created;
  }

  update(id: string, input: ScheduleInput): Schedule {
    const res = this.#db
      .prepare(
        `UPDATE schedules SET watchlist = ?, budget = ?, run_after_minute = ?, enabled = ?,
           last_skip = NULL, last_skip_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(input.watchlist),
        input.budget.toString(),
        input.runAfterMinute,
        input.enabled ? 1 : 0,
        this.#now().toISOString(),
        id,
      );
    if (res.changes !== 1) throw new ScheduleError('SCHEDULE_NOT_FOUND', 'no such schedule');
    const updated = this.get(id);
    if (updated === null) throw new ScheduleError('SCHEDULE_NOT_FOUND', 'no such schedule');
    return updated;
  }

  /** Remember why a due run could not start; only written when the reason changes. */
  noteSkip(id: string, reason: string | null): boolean {
    const current = this.get(id);
    if (current === null || current.lastSkip === reason) return false;
    this.#db
      .prepare('UPDATE schedules SET last_skip = ?, last_skip_at = ? WHERE id = ?')
      .run(
        reason === null ? null : reason.slice(0, 300),
        reason === null ? null : this.#now().toISOString(),
        id,
      );
    return true;
  }

  claimed(id: string, day: string): ScheduleRun | null {
    const row = this.#db
      .prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? AND day = ?')
      .get(id, day) as MaybeRow;
    return row === undefined ? null : runFromRow(row);
  }

  /** Claim the day for a run; throws (primary key) if the day is already claimed. */
  claim(id: string, day: string, runId: string): ScheduleRun {
    this.#db
      .prepare(
        'INSERT INTO schedule_runs (schedule_id, day, run_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, day, runId, this.#now().toISOString());
    const c = this.claimed(id, day);
    if (c === null) throw new Error('claim was not saved');
    return c;
  }

  runsOf(id: string, limit = 14): ScheduleRun[] {
    return (
      this.#db
        .prepare('SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY day DESC LIMIT ?')
        .all(id, Math.max(1, Math.min(limit, 100))) as Row[]
    ).map(runFromRow);
  }
}
