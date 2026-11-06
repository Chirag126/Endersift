/**
 * Print the 0G Router's raw /account/balance response (diagnostics).
 *
 *   pnpm zg:balance
 *   pnpm zg:balance -- --save-evidence
 *
 * Needs ZG_MANAGEMENT_KEY (mk-, scope account:read). The response holds the
 * account address and amounts only; it is still run through the evidence
 * secret scanner before being printed or saved. Used to find which field is
 * the spendable balance: the dashboard's "Main Account" (Payment Layer) can be
 * far above `total_balance`, because the Router pulls deposits in batches.
 */
import { loadEnv } from '../../packages/core/src/index.ts';
import { ZgRouterClient, formatZg } from '../../packages/zg/src/index.ts';
import {
  evidenceJson,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';
import { scanText } from '../lib/secret-patterns.ts';

handleScriptErrors();

const env = loadEnv(['zg'], loadLocalEnvSource());
const managementKey = env.get('ZG_MANAGEMENT_KEY');
if (managementKey === undefined)
  throw new Error('set ZG_MANAGEMENT_KEY (mk-, scope account:read) in .env first');
const client = new ZgRouterClient({ baseUrl: env.require('ZG_ROUTER_BASE_URL'), managementKey });

const raw = await client.getBalanceRaw();
const text = evidenceJson(raw);
if (scanText(text).length > 0)
  throw new Error('the balance response looks like it contains a secret; not printing it');

console.log(`0G Router /account/balance on ${env.require('ZG_NETWORK')} (${client.baseUrl}):\n`);
console.log(text);
// Every numeric string that looks like neuron, also shown in 0G, to compare with the dashboard.
if (typeof raw === 'object' && raw !== null) {
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && /^\d{1,40}$/.test(value))
      console.log(`  ${key.padEnd(28)} ${formatZg(BigInt(value))} 0G`);
  }
}
if (hasFlag('--save-evidence')) {
  const path = writeEvidence('zg', `balance-${env.require('ZG_NETWORK')}`, {
    kind: 'zg-balance-raw',
    readAt: new Date().toISOString(),
    network: env.require('ZG_NETWORK'),
    baseUrl: client.baseUrl,
    raw,
  });
  console.log(`\nEvidence written to ${path}`);
}
