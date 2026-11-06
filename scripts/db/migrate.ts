/**
 * Create or upgrade the local SQLite database at DATABASE_PATH.
 *
 *   pnpm db:migrate
 *
 * Fails fast on invalid configuration, an edited migration, or a database
 * written by a newer version of the code.
 */
import { loadServerConfig } from '../../apps/server/src/config.ts';
import { openDatabase } from '../../apps/server/src/db/database.ts';
import { handleScriptErrors, loadLocalEnvSource } from '../lib/cli.ts';

handleScriptErrors();

const config = loadServerConfig(loadLocalEnvSource());
const { db, migration } = openDatabase(config.databasePath);
console.log(`database ${config.databasePath}`);
console.log(
  migration.applied.length === 0
    ? `up to date at migration ${migration.current}`
    : `applied migrations ${migration.applied.join(', ')}; now at ${migration.current}`,
);
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all() as { name: string }[];
for (const { name } of tables) {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
  console.log(`  ${name.padEnd(22)} ${n} rows`);
}
db.close();
