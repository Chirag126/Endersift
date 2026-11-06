/**
 * The Daily brief form: watchlist, budget in HBAR and a UTC time. A
 * convenience only; the server validates again (D-056). Pure.
 */
import { hbar, parseHbar } from './format.ts';

export interface ScheduleDraft {
  readonly watchlist: string;
  readonly budget: string;
  readonly runAfter: string;
}

export type ScheduleCheck =
  | {
      readonly ok: true;
      readonly body: { watchlist: string[]; budget: string; runAfter: string };
    }
  | { readonly ok: false; readonly errors: Partial<Record<keyof ScheduleDraft, string>> };

export function watchlistItems(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,;]/)
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    ),
  ];
}

export function checkSchedule(d: ScheduleDraft, maxPerRun: string): ScheduleCheck {
  const errors: Partial<Record<keyof ScheduleDraft, string>> = {};
  const items = watchlistItems(d.watchlist);
  if (items.length === 0) errors.watchlist = 'Add at least one product, package or vendor.';
  else if (items.length > 20) errors.watchlist = 'At most 20 items.';
  const budget = parseHbar(d.budget);
  if (budget === null) errors.budget = 'Enter an amount in HBAR, up to 8 decimals.';
  else if (budget <= 0n) errors.budget = 'Must be more than zero.';
  else if (budget > BigInt(maxPerRun))
    errors.budget = `At most ${hbar(maxPerRun)} HBAR, the per-task limit in force.`;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.runAfter.trim()))
    errors.runAfter = 'A UTC time as HH:MM, such as 00:15.';
  if (Object.keys(errors).length > 0 || budget === null) return { ok: false, errors };
  return {
    ok: true,
    body: { watchlist: items, budget: budget.toString(), runAfter: d.runAfter.trim() },
  };
}

/** Whether today's (UTC) time for "HH:MM" has already passed: saving then starts a brief at once. Pure. */
export function passedToday(runAfter: string, now: Date): boolean {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(runAfter.trim());
  if (m === null) return false;
  return now.getUTCHours() * 60 + now.getUTCMinutes() >= Number(m[1]) * 60 + Number(m[2]);
}

/** "Every day after 00:15 UTC (05:45 in your time zone)". */
export function whenText(runAfter: string, localOffsetMinutes: number): string {
  const [h, m] = runAfter.split(':').map(Number);
  const utc = (h ?? 0) * 60 + (m ?? 0);
  const local = (((utc - localOffsetMinutes) % 1440) + 1440) % 1440;
  const fmt = (x: number) =>
    `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  return localOffsetMinutes === 0
    ? `Every day after ${runAfter} UTC`
    : `Every day after ${runAfter} UTC (${fmt(local)} your time)`;
}
