/**
 * The delta brief (plan row 28, D-056): what changed since the previous brief
 * for the same watchlist.
 *
 * A run with an accepted 0G analysis records a digest in its
 * ANALYSIS_COMPLETED event: the advisory IDs the analyst was given (with
 * severity and CISA KEV status) and the priorities it assigned. The next run
 * for the same watchlist compares its own digest with the latest earlier one:
 * new advisories, advisories no longer in the analysed data, and priority
 * changes. The comparison is deterministic: no model is asked what changed.
 *
 * Runs recorded before digests existed have none, so the first brief after
 * this change has nothing to compare with, and says so.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { StackAnalysis } from '@agent-economy/core/domain';
import type { SourcedItem } from './prompts.ts';

export const DIGEST_PRIORITIES = ['p1', 'p2', 'p3'] as const;
export type DigestPriority = (typeof DIGEST_PRIORITIES)[number];

export interface DigestItem {
  readonly id: string;
  readonly severity: string;
  readonly exploited: boolean;
  /** The analyst's priority; null = given to the analyst but not assessed as affecting the watchlist. */
  readonly priority: DigestPriority | null;
}

export interface Digest {
  readonly items: readonly DigestItem[];
}

export interface PriorityChange {
  readonly id: string;
  readonly from: DigestPriority | null;
  readonly to: DigestPriority | null;
}

export interface Delta {
  readonly previousRunId: string;
  readonly previousAt: string;
  readonly added: readonly DigestItem[];
  readonly gone: readonly DigestItem[];
  readonly changed: readonly PriorityChange[];
  readonly unchanged: number;
}

const MAX_DIGEST = 60;

/** The digest of an accepted analysis. Pure. */
export function digestOf(items: readonly SourcedItem[], triage: StackAnalysis): Digest {
  const priority = new Map(triage.assessments.map((a) => [a.id.toUpperCase(), a.priority]));
  return {
    items: items.slice(0, MAX_DIGEST).map((s) => ({
      id: s.item.id,
      severity: s.item.severity,
      exploited: s.item.exploited !== null && s.item.exploited !== undefined,
      priority: priority.get(s.item.id.toUpperCase()) ?? null,
    })),
  };
}

const PRIORITY_SET = new Set<string>(DIGEST_PRIORITIES);

/** A digest read back from an event payload (untrusted shape); null if malformed. Pure. */
export function parseDigest(v: unknown): Digest | null {
  if (typeof v !== 'object' || v === null) return null;
  const items = (v as Record<string, unknown>)['items'];
  if (!Array.isArray(items)) return null;
  const out: DigestItem[] = [];
  for (const it of items.slice(0, MAX_DIGEST)) {
    if (typeof it !== 'object' || it === null) return null;
    const r = it as Record<string, unknown>;
    const id = r['id'];
    const p = r['priority'];
    if (typeof id !== 'string' || id === '') return null;
    out.push({
      id,
      severity: typeof r['severity'] === 'string' ? r['severity'] : 'unknown',
      exploited: r['exploited'] === true,
      priority: typeof p === 'string' && PRIORITY_SET.has(p) ? (p as DigestPriority) : null,
    });
  }
  return { items: out };
}

/** Compare two digests by advisory ID (case-insensitive). Pure. */
export function computeDelta(
  previous: { readonly runId: string; readonly at: string; readonly digest: Digest },
  current: Digest,
): Delta {
  const key = (id: string) => id.toUpperCase();
  const before = new Map(previous.digest.items.map((i) => [key(i.id), i]));
  const now = new Map(current.items.map((i) => [key(i.id), i]));
  const added = current.items.filter((i) => !before.has(key(i.id)));
  const gone = previous.digest.items.filter((i) => !now.has(key(i.id)));
  const changed: PriorityChange[] = [];
  let unchanged = 0;
  for (const i of current.items) {
    const was = before.get(key(i.id));
    if (was === undefined) continue;
    if (was.priority === i.priority) unchanged += 1;
    else changed.push({ id: i.id, from: was.priority, to: i.priority });
  }
  return {
    previousRunId: previous.runId,
    previousAt: previous.at,
    added,
    gone,
    changed,
    unchanged,
  };
}

/** Lower-case, trimmed, de-duplicated and sorted: two watchlists match when their items do. Pure. */
export function watchlistKey(watchlist: readonly string[]): string {
  return JSON.stringify(
    [...new Set(watchlist.map((w) => w.trim().toLowerCase()).filter((w) => w !== ''))].sort(),
  );
}

interface DigestRow {
  readonly id: string;
  readonly watchlist: string;
  readonly payload: string;
  readonly at: string;
}

/**
 * The latest earlier run for the same watchlist that recorded a digest (an
 * accepted analysis in a SUCCEEDED run). Reads only; null when there is none.
 */
export function previousDigest(
  db: DatabaseSync,
  run: { readonly id: string; readonly watchlist: readonly string[]; readonly createdAt: string },
): { runId: string; at: string; digest: Digest } | null {
  const want = watchlistKey(run.watchlist);
  const rows = db
    .prepare(
      `SELECT r.id AS id, r.watchlist AS watchlist, e.payload AS payload, e.at AS at
       FROM runs r JOIN run_events e ON e.run_id = r.id AND e.type = 'ANALYSIS_COMPLETED'
       WHERE r.id <> ? AND r.status = 'SUCCEEDED' AND r.created_at < ?
       ORDER BY r.created_at DESC LIMIT 200`,
    )
    .all(run.id, run.createdAt) as unknown as DigestRow[];
  for (const row of rows) {
    let watchlist: unknown;
    let payload: unknown;
    try {
      watchlist = JSON.parse(row.watchlist);
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!Array.isArray(watchlist) || !watchlist.every((w) => typeof w === 'string')) continue;
    if (watchlistKey(watchlist as string[]) !== want) continue;
    const p = payload as Record<string, unknown>;
    if (p['accepted'] !== true) continue;
    const digest = parseDigest(p['digest']);
    if (digest === null) continue;
    return { runId: row.id, at: row.at, digest };
  }
  return null;
}
