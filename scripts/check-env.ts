/**
 * Validate YOUR local .env for the integrations you are about to use.
 * Prints names and statuses only, never values.
 *
 *   pnpm env:check                       all groups
 *   pnpm env:check -- --groups hedera,x402
 *   pnpm env:check -- --file .env.local
 */
import { ENV_GROUPS, checkEnv, type EnvGroup } from '../packages/core/src/index.ts';
import { argValue, loadLocalEnvSource } from './lib/cli.ts';

const file = argValue('--file') ?? '.env';
const groupArg = argValue('--groups');
const groups = (groupArg?.split(',').map((g) => g.trim()) ?? [...ENV_GROUPS]) as EnvGroup[];

const unknown = groups.filter((g) => !(ENV_GROUPS as readonly string[]).includes(g));
if (unknown.length > 0) {
  console.error(`Unknown group(s): ${unknown.join(', ')}. Valid: ${ENV_GROUPS.join(', ')}`);
  process.exit(2);
}

const report = checkEnv(groups, loadLocalEnvSource(file));

const label: Record<string, string> = {
  ok: 'OK      ',
  default: 'DEFAULT ',
  'unset-optional': 'OPTIONAL',
  missing: 'MISSING ',
  invalid: 'INVALID ',
};
for (const v of report.vars) {
  const reason = v.reason !== undefined ? `  (${v.reason})` : '';
  console.log(`${label[v.status]}  [${v.group}] ${v.name}${v.secret ? ' (secret)' : ''}${reason}`);
}
for (const e of report.crossFieldErrors) console.log(`ERROR     ${e}`);

console.log(report.ok ? '\nenv:check passed.' : '\nenv:check failed.');
process.exitCode = report.ok ? 0 : 1;
