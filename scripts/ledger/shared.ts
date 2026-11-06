/**
 * Shared setup for the ledger scripts: env (core + zg), the SQLite ledger at
 * DATABASE_PATH, the Router client, and table formatting.
 */
import type { InferenceCall, ZgBalanceSnapshot } from '../../packages/core/src/domain/index.ts';
import { loadEnv } from '../../packages/core/src/index.ts';
import { ZgRouterClient, formatZg } from '../../packages/zg/src/index.ts';
import { openDatabase } from '../../apps/server/src/db/database.ts';
import { SqliteInferenceLedger } from '../../apps/server/src/ledger/inference-ledger.ts';
import { UsageError, loadLocalEnvSource } from '../lib/cli.ts';

export function ledgerSetup(options: { readonly needManagementKey: boolean }) {
  const env = loadEnv(['core', 'zg'], loadLocalEnvSource());
  const managementKey = env.get('ZG_MANAGEMENT_KEY');
  if (options.needManagementKey && managementKey === undefined)
    throw new UsageError('set ZG_MANAGEMENT_KEY (mk-, scope account:read) in .env first');
  const databasePath = env.require('DATABASE_PATH');
  const { db, migration } = openDatabase(databasePath);
  const client = new ZgRouterClient({
    baseUrl: env.require('ZG_ROUTER_BASE_URL'),
    apiKey: env.require('ZG_API_KEY'),
    chatTimeoutMs: Number(env.require('ZG_TIMEOUT_MS')),
    ...(managementKey === undefined ? {} : { managementKey }),
  });
  return {
    env,
    db,
    migration,
    databasePath,
    client,
    ledger: new SqliteInferenceLedger(db),
    network: env.require('ZG_NETWORK') as InferenceCall['network'],
    modelId: env.require('ZG_MODEL'),
    capNeuron: BigInt(env.require('ZG_MAX_CALL_COST_NEURON')),
    dailyCapNeuron: BigInt(env.require('ZG_DAILY_CAP_NEURON')),
    timeoutMs: Number(env.require('ZG_TIMEOUT_MS')),
    snapshotIntervalMin: Number(env.require('ZG_SNAPSHOT_INTERVAL_MIN')),
  };
}

export const zg = (n: bigint | string | null): string =>
  n === null ? '-' : `${formatZg(BigInt(n))} 0G`;

export function callLine(c: InferenceCall): string {
  return [
    c.createdAt.slice(11, 19),
    c.purpose.padEnd(7),
    c.status.padEnd(9),
    (c.requestId ?? '-').padEnd(36),
    zg(c.costNeuron).padStart(16),
    c.errorCode ?? '',
  ]
    .join('  ')
    .trimEnd();
}

export function snapshotLine(s: ZgBalanceSnapshot): string {
  return (
    `${s.takenAt}  ${s.trigger.padEnd(6)}  float ${zg(s.totalBalanceNeuron)}  ` +
    `pending ${zg(s.pendingChargeNeuron)}  credits ${zg(s.creditBalanceNeuron)}`
  );
}
