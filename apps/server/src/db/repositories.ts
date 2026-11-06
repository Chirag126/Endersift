/**
 * Typed repositories over the SQLite schema. Every write is validated with
 * the domain schema first; every read is parsed back through it, so a row
 * that does not satisfy the domain model raises instead of leaking.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ProviderAgent, Report, Run, RunEvent } from '@agent-economy/core/domain';

type Row = Record<string, unknown>;

export class RepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryError';
  }
}

const json = (v: unknown): string => JSON.stringify(v);
const parseJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

// ── providers ─────────────────────────────────────────────────────────────

export function upsertProvider(db: DatabaseSync, input: ProviderAgent): ProviderAgent {
  const p = ProviderAgent.parse(input);
  db.prepare(
    `INSERT INTO providers (ens_name, label, chain, resolver, endpoint, capabilities, pay_to, network, asset, price_atomic, discovered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ens_name) DO UPDATE SET
       label = excluded.label, chain = excluded.chain, resolver = excluded.resolver, endpoint = excluded.endpoint,
       capabilities = excluded.capabilities, pay_to = excluded.pay_to, network = excluded.network,
       asset = excluded.asset, price_atomic = excluded.price_atomic, discovered_at = excluded.discovered_at`,
  ).run(
    p.ensName,
    p.label,
    p.chain,
    p.resolver,
    p.endpoint,
    json(p.capabilities),
    p.payTo,
    p.network,
    p.asset,
    p.priceAtomic,
    p.discoveredAt,
  );
  return p;
}

const providerFromRow = (r: Row): ProviderAgent =>
  ProviderAgent.parse({
    ensName: r['ens_name'],
    label: r['label'],
    chain: r['chain'],
    resolver: r['resolver'],
    endpoint: r['endpoint'],
    capabilities: parseJson(r['capabilities']),
    payTo: r['pay_to'],
    network: r['network'],
    asset: r['asset'],
    priceAtomic: r['price_atomic'],
    discoveredAt: r['discovered_at'],
  });

export function listProviders(db: DatabaseSync): ProviderAgent[] {
  return (db.prepare('SELECT * FROM providers ORDER BY ens_name').all() as Row[]).map(
    providerFromRow,
  );
}

// ── runs and events ───────────────────────────────────────────────────────

export function createRun(db: DatabaseSync, input: Run): Run {
  const r = Run.parse(input);
  db.prepare(
    `INSERT INTO runs (id, trigger, watchlist, status, created_at, started_at, finished_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    r.id,
    r.trigger,
    json(r.watchlist),
    r.status,
    r.createdAt,
    r.startedAt,
    r.finishedAt,
    r.error,
  );
  return r;
}

const runFromRow = (r: Row): Run =>
  Run.parse({
    id: r['id'],
    trigger: r['trigger'],
    watchlist: parseJson(r['watchlist']),
    status: r['status'],
    createdAt: r['created_at'],
    startedAt: r['started_at'],
    finishedAt: r['finished_at'],
    error: r['error'],
  });

export function getRun(db: DatabaseSync, id: string): Run | null {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
  return row === undefined ? null : runFromRow(row);
}

/** The most recent runs first. */
export function listRuns(db: DatabaseSync, limit: number): Run[] {
  return (
    db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 200))) as Row[]
  ).map(runFromRow);
}

export function updateRun(db: DatabaseSync, run: Run): Run {
  const r = Run.parse(run);
  const res = db
    .prepare('UPDATE runs SET status = ?, started_at = ?, finished_at = ?, error = ? WHERE id = ?')
    .run(r.status, r.startedAt, r.finishedAt, r.error, r.id);
  if (res.changes !== 1) throw new RepositoryError(`run ${r.id} does not exist`);
  return r;
}

/**
 * QUEUED → RUNNING as a compare-and-set: of two processes starting the same
 * run, exactly one gets it. Returns the started run, or null if it was not QUEUED.
 */
export function startRun(db: DatabaseSync, id: string, at: string): Run | null {
  const res = db
    .prepare(
      "UPDATE runs SET status = 'RUNNING', started_at = ? WHERE id = ? AND status = 'QUEUED'",
    )
    .run(at, id);
  return res.changes === 1 ? getRun(db, id) : null;
}

/** Append an event with the next sequence number, atomically. */
export function appendRunEvent(db: DatabaseSync, input: Omit<RunEvent, 'seq'>): RunEvent {
  db.exec('BEGIN IMMEDIATE');
  try {
    const next = db
      .prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS next FROM run_events WHERE run_id = ?')
      .get(input.runId) as { next: number };
    const e = RunEvent.parse({ ...input, seq: Number(next.next) });
    db.prepare(
      'INSERT INTO run_events (run_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)',
    ).run(e.runId, e.seq, e.type, json(e.payload), e.at);
    db.exec('COMMIT');
    return e;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listRunEvents(db: DatabaseSync, runId: string, afterSeq = -1): RunEvent[] {
  return (
    db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq')
      .all(runId, afterSeq) as Row[]
  ).map((r) =>
    RunEvent.parse({
      runId: r['run_id'],
      seq: Number(r['seq']),
      type: r['type'],
      payload: parseJson(r['payload']),
      at: r['at'],
    }),
  );
}

// Payment intents live in the payment store (src/payments, D-042), behind an async interface.

// Inference calls live in the inference ledger (src/ledger, D-040), behind an async interface.

// ── reports ───────────────────────────────────────────────────────────────

export function saveReport(db: DatabaseSync, input: Report): Report {
  const r = Report.parse(input);
  db.prepare(
    `INSERT INTO reports (run_id, markdown, created_at) VALUES (?, ?, ?)
     ON CONFLICT (run_id) DO UPDATE SET markdown = excluded.markdown, created_at = excluded.created_at`,
  ).run(r.runId, r.markdown, r.createdAt);
  return r;
}

export function getReport(db: DatabaseSync, runId: string): Report | null {
  const row = db.prepare('SELECT * FROM reports WHERE run_id = ?').get(runId) as Row | undefined;
  return row === undefined
    ? null
    : Report.parse({
        runId: row['run_id'],
        markdown: row['markdown'],
        createdAt: row['created_at'],
      });
}
