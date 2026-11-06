/**
 * Runs API tasks one at a time (plan row 26, D-048). A task is a run: queued
 * at once (so the client gets its ID and can stream its events), executed in
 * order by a single worker. One worker per process keeps payments and 0G calls
 * sequential, which the per-run budgets and the shared daily caps assume.
 */
import type { Run } from '@agent-economy/core/domain';
import type {
  ExecuteOptions,
  RunOrigin,
  RunRequest,
  RunResult,
} from '../orchestrator/orchestrator.ts';

export interface SubmitOptions {
  /** Who started it (recorded in RUN_STARTED); default 'api'. */
  readonly origin?: RunOrigin;
  /** Runs after the run is queued and before it is scheduled; a throw leaves it unscheduled. */
  readonly beforeStart?: (run: Run) => void;
}

/** What the runner needs from the orchestrator. */
export interface RunExecutor {
  queue(request: RunRequest): Run;
  execute(runId: string, options?: ExecuteOptions): Promise<RunResult>;
  checkBudget(budget: bigint | undefined): void;
  recoverInterrupted(olderThanMs?: number): Run[];
}

export class QueueFullError extends Error {
  constructor(max: number) {
    super(`${max} tasks are already waiting; try again later`);
    this.name = 'QueueFullError';
  }
}

export interface TaskRunnerOptions {
  /** Tasks waiting behind the running one. */
  readonly maxPending?: number;
  readonly onError?: (runId: string, error: unknown) => void;
}

export class TaskRunner {
  readonly #executor: RunExecutor;
  readonly #maxPending: number;
  readonly #onError: (runId: string, error: unknown) => void;
  readonly #pending: { id: string; options: ExecuteOptions }[] = [];
  #running: string | null = null;
  #idle: Promise<void> = Promise.resolve();
  #wake: (() => void) | null = null;

  constructor(executor: RunExecutor, options: TaskRunnerOptions = {}) {
    this.#executor = executor;
    this.#maxPending = options.maxPending ?? 3;
    this.#onError = options.onError ?? (() => {});
  }

  /** Close runs a previous process left open (call once at startup). */
  recover(): Run[] {
    return this.#executor.recoverInterrupted(0);
  }

  /**
   * Validate, queue and schedule a task. Throws (and records nothing) for a
   * budget above the one in force, paused payments or a full queue.
   */
  submit(
    request: RunRequest,
    budget?: bigint,
    o: SubmitOptions = {},
  ): { run: Run; position: number } {
    this.#executor.checkBudget(budget);
    if (this.#pending.length >= this.#maxPending) throw new QueueFullError(this.#maxPending);
    const run = this.#executor.queue(request);
    // e.g. the scheduler's claim of the day; if it throws, the run is not scheduled
    o.beforeStart?.(run);
    const origin = o.origin ?? 'api';
    this.#pending.push({
      id: run.id,
      options: budget === undefined ? { origin } : { budget, origin },
    });
    const position = this.#pending.length + (this.#running === null ? 0 : 1);
    this.#kick();
    return { run, position };
  }

  status(): { running: string | null; pending: number } {
    return { running: this.#running, pending: this.#pending.length };
  }

  /**
   * Forget the waiting tasks (shutdown): they stay QUEUED in the database and
   * are cancelled by `recover()` at the next start. The running task finishes.
   */
  drop(): string[] {
    return this.#pending.splice(0).map((p) => p.id);
  }

  /** Resolves when the queue is empty and nothing runs (tests, shutdown). */
  idle(): Promise<void> {
    return this.#idle;
  }

  #kick(): void {
    if (this.#running !== null || this.#pending.length === 0) return;
    this.#idle = new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
    void this.#drain();
  }

  async #drain(): Promise<void> {
    for (;;) {
      const next = this.#pending.shift();
      if (next === undefined) break;
      this.#running = next.id;
      try {
        await this.#executor.execute(next.id, next.options);
      } catch (error) {
        // execute() records every pipeline failure itself; this is a failure to start or record
        this.#onError(next.id, error);
      } finally {
        this.#running = null;
      }
    }
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}
