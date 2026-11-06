/**
 * Daily activity for the charts (D-089): real rows from the API, grouped by
 * UTC day. Nothing is estimated or filled in: a day with no rows is zero, and
 * a chart with no rows at all shows an empty state. Pure.
 */

/** The last `n` UTC days, oldest first, as YYYY-MM-DD. */
export function lastUtcDays(n: number, now: Date): string[] {
  const out: string[] = [];
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = n - 1; i >= 0; i -= 1)
    out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

export interface DaySegment {
  readonly key: string;
  readonly value: bigint;
}

export interface DayColumn {
  readonly day: string;
  readonly segments: readonly DaySegment[];
  readonly total: bigint;
}

/**
 * Group rows into the given days. `at` gives a row's ISO timestamp, `key` its
 * segment (e.g. a verdict), `value` its amount (1n to count rows). Rows
 * outside the days are ignored; segments keep the order of `keys`.
 */
export function byDay<T>(
  rows: readonly T[],
  days: readonly string[],
  keys: readonly string[],
  at: (row: T) => string,
  key: (row: T) => string | null,
  value: (row: T) => bigint,
): DayColumn[] {
  const index = new Map(days.map((d, i) => [d, i]));
  const sums = days.map(() => new Map<string, bigint>(keys.map((k) => [k, 0n])));
  for (const row of rows) {
    const i = index.get(at(row).slice(0, 10));
    const k = key(row);
    if (i === undefined || k === null) continue;
    const m = sums[i];
    if (m === undefined || !m.has(k)) continue;
    m.set(k, (m.get(k) ?? 0n) + value(row));
  }
  return days.map((day, i) => {
    const m = sums[i] ?? new Map<string, bigint>();
    const segments = keys.map((k) => ({ key: k, value: m.get(k) ?? 0n }));
    return { day, segments, total: segments.reduce((s, x) => s + x.value, 0n) };
  });
}

/** Bar height in percent of the tallest column (0 when every column is empty). */
export function share(value: bigint, max: bigint): number {
  if (max <= 0n || value <= 0n) return 0;
  return Number((value * 10_000n) / max) / 100;
}

/** The server's UTC day (YYYY-MM-DD) as a date, so the charts end on the server's today. */
export function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** "Nov 6" from YYYY-MM-DD, in UTC. */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
