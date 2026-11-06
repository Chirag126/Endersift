/**
 * The scheduler (plan row 28, D-056): once a minute, each enabled schedule
 * whose time has come today (UTC) and whose day is not yet claimed starts one
 * run through the task runner, with its own budget.
 *
 *   - Only today: a missed day is never back-filled. Starting the server after
 *     the time runs today's brief (catch-up); yesterday's stays missed.
 *   - The claim and the queued run are written before the run starts; a second
 *     claim for the same day is refused by the database, and its run cancelled.
 *   - A run that cannot start (payments paused, budget above the limit in
 *     force, queue full) is not claimed: the reason is noted on the schedule
 *     and the next tick tries again, until the UTC day ends.
 *   - The kill switch, the firewall and every budget apply as for any task.
 *   - On a host that wipes the database when it restarts (D-062), a restart
 *     forgets today's claim. There the catch-up is limited to a window after
 *     the time (`catchUpWindowMin`), so waking the server later in the day
 *     does not run the day's brief a second time.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Run } from '@agent-economy/core/domain';
import { getRun, updateRun } from '../db/repositories.ts';
import type { RunRequest } from '../orchestrator/orchestrator.ts';
import type { Schedule, ScheduleStore } from './schedule-store.ts';

export interface DueCheck {
  readonly day: string;
  readonly dueAt: string;
  readonly due: boolean;
}

/** Today's (UTC) due time for a schedule, and whether it has passed. Pure. */
export function dueToday(s: Pick<Schedule, 'runAfterMinute'>, now: Date): DueCheck {
  const day = now.toISOString().slice(0, 10);
  const dueAt = new Date(Date.parse(`${day}T00:00:00.000Z`) + s.runAfterMinute * 60_000);
  return { day, dueAt: dueAt.toISOString(), due: now.getTime() >= dueAt.getTime() };
}

/** The catch-up window on a host that wipes its database (D-062), in minutes after the due time. */
export const CATCH_UP_WINDOW_MIN = 120;

/** True when today's catch-up window (minutes after the due time) has passed. Pure. */
export function windowPassed(due: DueCheck, now: Date, windowMin: number | null): boolean {
  return windowMin !== null && now.getTime() > Date.parse(due.dueAt) + windowMin * 60_000;
}

/**
 * The next time a schedule will start a run: today if not yet claimed and
 * still inside its catch-up window, else tomorrow. Pure.
 */
export function nextRunAt(
  s: Pick<Schedule, 'runAfterMinute' | 'enabled'>,
  now: Date,
  claimedToday: boolean,
  windowMin: number | null = null,
): string | null {
  if (!s.enabled) return null;
  const today = dueToday(s, now);
  const tomorrow = new Date(Date.parse(today.dueAt) + 86_400_000).toISOString();
  if (claimedToday || windowPassed(today, now, windowMin)) return tomorrow;
  return today.due ? now.toISOString() : today.dueAt;
}

export type Submit = (
  request: RunRequest,
  budget: bigint,
  beforeStart: (run: Run) => void,
) => { run: Run };

export interface TickOutcome {
  readonly scheduleId: string;
  readonly result: 'started' | 'not-due' | 'already-ran' | 'disabled' | 'skipped' | 'window-passed';
  readonly runId?: string;
  readonly reason?: string;
}

const reasonOf = (e: unknown): string => {
  if (e instanceof Error) {
    if (e.name === 'PaymentsPausedError') return 'PAYMENTS_PAUSED: payments are paused';
    if (e.name === 'QueueFullError') return `QUEUE_FULL: ${e.message}`;
    if (e instanceof RangeError) return `INVALID_BUDGET: ${e.message}`;
    if (e.name === 'ScheduleClaimError') return `ALREADY_CLAIMED: ${e.message}`;
    return `${e.name}: ${e.message}`.slice(0, 300);
  }
  return String(e).slice(0, 300);
};

class ScheduleClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleClaimError';
  }
}

export interface SchedulerOptions {
  readonly db: DatabaseSync;
  readonly store: ScheduleStore;
  readonly submit: Submit;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  /**
   * Minutes after the due time during which an unclaimed day still starts
   * (null = the whole UTC day). Set on hosts that wipe the database (D-062).
   */
  readonly catchUpWindowMin?: number | null;
}

export class Scheduler {
  readonly #o: SchedulerOptions;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: SchedulerOptions) {
    this.#o = o;
  }

  #now(): Date {
    return (this.#o.now ?? (() => new Date()))();
  }

  /** Evaluate every schedule once. Synchronous: decisions and claims happen here. */
  tick(): TickOutcome[] {
    const now = this.#now();
    const out: TickOutcome[] = [];
    for (const s of this.#o.store.list()) {
      if (!s.enabled) {
        out.push({ scheduleId: s.id, result: 'disabled' });
        continue;
      }
      const due = dueToday(s, now);
      if (!due.due) {
        out.push({ scheduleId: s.id, result: 'not-due' });
        continue;
      }
      const claimed = this.#o.store.claimed(s.id, due.day);
      if (claimed !== null) {
        out.push({ scheduleId: s.id, result: 'already-ran', runId: claimed.runId });
        continue;
      }
      if (windowPassed(due, now, this.#o.catchUpWindowMin ?? null)) {
        out.push({ scheduleId: s.id, result: 'window-passed' });
        continue;
      }
      try {
        const { run } = this.#o.submit(
          { trigger: 'scheduled', watchlist: s.watchlist },
          s.budget,
          (queued) => {
            try {
              this.#o.store.claim(s.id, due.day, queued.id);
            } catch (error) {
              // another process claimed the day first: this run never starts
              const r = getRun(this.#o.db, queued.id);
              if (r !== null && r.status === 'QUEUED')
                updateRun(this.#o.db, {
                  ...r,
                  status: 'CANCELLED',
                  finishedAt: now.toISOString(),
                  error: `DUPLICATE_SCHEDULED_RUN: ${due.day} was already claimed`,
                });
              throw new ScheduleClaimError(
                `${due.day} already claimed (${error instanceof Error ? error.message : String(error)})`,
              );
            }
          },
        );
        this.#o.store.noteSkip(s.id, null);
        this.#o.log?.(`schedule ${s.id}: started run ${run.id} for ${due.day}`);
        out.push({ scheduleId: s.id, result: 'started', runId: run.id });
      } catch (error) {
        const reason = reasonOf(error);
        if (this.#o.store.noteSkip(s.id, reason))
          this.#o.log?.(`schedule ${s.id}: due but not started (${reason}); retrying each minute`);
        out.push({ scheduleId: s.id, result: 'skipped', reason });
      }
    }
    return out;
  }

  /** Tick now and then every `intervalMs` (default one minute). */
  start(intervalMs = 60_000): void {
    if (this.#timer !== null) return;
    this.#safeTick();
    this.#timer = setInterval(() => this.#safeTick(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #safeTick(): void {
    try {
      this.tick();
    } catch (error) {
      this.#o.log?.(
        `scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
