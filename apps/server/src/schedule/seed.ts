/**
 * The daily brief from configuration (D-062). On a host that wipes the
 * database when it restarts, schedules made on the Daily brief page do not
 * survive; DAILY_BRIEF_WATCHLIST, DAILY_BRIEF_RUN_AFTER and
 * DAILY_BRIEF_BUDGET_TINYBARS describe one that is created at startup when no
 * schedule with the same watchlist and time exists. Invalid values stop the
 * server (fail fast), like any other configuration error.
 */
import { parseWatchlist } from '../orchestrator/watchlist.ts';
import { parseRunAfter, type Schedule, type ScheduleStore } from './schedule-store.ts';

export class SeedScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedScheduleError';
  }
}

export interface SeedInput {
  readonly watchlist: string;
  readonly runAfter: string;
  readonly budget: bigint;
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Create the configured daily brief unless an identical one exists. */
export function seedDailyBrief(
  store: ScheduleStore,
  input: SeedInput,
  maxPerRun: bigint,
): { readonly created: boolean; readonly schedule: Schedule } {
  let watchlist: string[];
  try {
    watchlist = parseWatchlist(input.watchlist);
  } catch (error) {
    throw new SeedScheduleError(
      `DAILY_BRIEF_WATCHLIST: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const runAfterMinute = parseRunAfter(input.runAfter);
  if (runAfterMinute === null)
    throw new SeedScheduleError('DAILY_BRIEF_RUN_AFTER must be HH:MM (UTC)');
  if (input.budget <= 0n || input.budget > maxPerRun)
    throw new SeedScheduleError(
      `DAILY_BRIEF_BUDGET_TINYBARS must be between 1 and ${maxPerRun} (the run budget)`,
    );
  const existing = store
    .list()
    .find((s) => s.runAfterMinute === runAfterMinute && sameList(s.watchlist, watchlist));
  if (existing !== undefined) return { created: false, schedule: existing };
  return {
    created: true,
    schedule: store.create({ watchlist, budget: input.budget, runAfterMinute, enabled: true }),
  };
}
