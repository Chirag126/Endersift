/**
 * The activity log's paging (GET /api/logs): newest first, ten at a time.
 * "Show 10 more" reveals what is loaded and fetches the next page only when
 * needed; "Show less" goes back to ten. Live updates are merged on top
 * without duplicates. Pure.
 */
import type { LogEntry } from './types.ts';

export const PAGE = 10;

/** Merge entries by id, newest (highest id) first. */
export function mergeEntries(
  current: readonly LogEntry[],
  incoming: readonly LogEntry[],
): LogEntry[] {
  const byId = new Map<number, LogEntry>();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

export interface LogView {
  /** How many entries are shown. */
  readonly visible: number;
  /** The server cursor for older entries; null when everything is loaded. */
  readonly next: number | null;
}

/** What "Show 10 more" needs: just reveal, or fetch first. */
export function moreAction(view: LogView, loaded: number): 'reveal' | 'fetch' | 'none' {
  if (view.visible + PAGE <= loaded) return 'reveal';
  if (view.next !== null) return 'fetch';
  return view.visible < loaded ? 'reveal' : 'none';
}

export const canShowLess = (view: LogView): boolean => view.visible > PAGE;

/** The payload as indented JSON for the details panel (already redacted by the server). */
export const prettyJson = (v: unknown): string => JSON.stringify(v, null, 2);
