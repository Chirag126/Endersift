/**
 * SQLite access through Node's built-in `node:sqlite` (no native module to
 * compile, which matters on Windows). Opening a database turns on foreign
 * keys and WAL, then applies pending migrations inside a transaction.
 *
 * Safety: each applied migration's SHA-256 is stored; if code ships a changed
 * migration, or the database knows a migration the code does not (it was
 * written by a newer version), opening fails instead of guessing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations.ts';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export const checksum = (m: Migration): string => createHash('sha256').update(m.sql).digest('hex');

export interface MigrationResult {
  readonly applied: readonly number[];
  readonly current: number;
}

export function migrate(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
  ) STRICT`);
  const known = new Map(migrations.map((m) => [m.id, m]));
  const rows = db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all() as {
    id: number;
    checksum: string;
  }[];
  for (const row of rows) {
    const m = known.get(row.id);
    if (m === undefined) {
      throw new MigrationError(
        `database has migration ${row.id}, which this code does not know (newer database?)`,
      );
    }
    if (checksum(m) !== row.checksum) {
      throw new MigrationError(
        `migration ${row.id} was changed after it was applied; add a new migration instead`,
      );
    }
  }
  const done = new Set(rows.map((r) => r.id));
  const ids = migrations.map((m) => m.id);
  if (ids.some((id, i) => i > 0 && id <= (ids[i - 1] ?? 0)))
    throw new MigrationError('migration IDs must increase');

  const applied: number[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare(
        'INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      ).run(m.id, m.name, checksum(m), new Date().toISOString());
      db.exec('COMMIT');
      applied.push(m.id);
    } catch (error) {
      db.exec('ROLLBACK');
      throw new MigrationError(
        `migration ${m.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    applied,
    current: Math.max(0, ...ids.filter((id) => done.has(id) || applied.includes(id))),
  };
}

/** Open (creating the directory if needed), configure and migrate. ':memory:' works for tests. */
export function openDatabase(
  path: string,
  migrations: readonly Migration[] = MIGRATIONS,
): {
  db: DatabaseSync;
  migration: MigrationResult;
} {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  const migration = migrate(db, migrations);
  return { db, migration };
}
