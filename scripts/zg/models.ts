/**
 * Read the live 0G Router model catalog (no credentials needed).
 *
 *   pnpm zg:models                                  network from ZG_NETWORK / ZG_ROUTER_BASE_URL
 *   pnpm zg:models -- --network testnet             documented testnet Router instead
 *   pnpm zg:models -- --save-evidence
 *
 * Prints each model's ID and price per 1M tokens, and whether the configured
 * ZG_MODEL (if any) is in the catalog. Exit 1 if the catalog cannot be read,
 * or if ZG_MODEL is set but missing from it.
 */
import { ZG_ROUTER_HOSTS, loadEnv } from '../../packages/core/src/index.ts';
import { ZgRouterClient, formatZg } from '../../packages/zg/src/index.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const source = loadLocalEnvSource();
const override = argValue('--network');
let network: 'mainnet' | 'testnet';
let baseUrl: string;
if (override !== undefined) {
  if (override !== 'mainnet' && override !== 'testnet') {
    throw new Error('--network must be mainnet or testnet');
  }
  network = override;
  baseUrl = `https://${ZG_ROUTER_HOSTS[network]}/v1`;
} else {
  const env = loadEnv(['zg-network'], source);
  network = env.require('ZG_NETWORK') as 'mainnet' | 'testnet';
  baseUrl = env.require('ZG_ROUTER_BASE_URL');
}

const configuredModel = source['ZG_MODEL']?.trim() || null;
const client = new ZgRouterClient({ baseUrl });
const fetchedAt = new Date().toISOString();
console.log(`0G Router catalog (${network}): ${client.baseUrl}/models\n`);

const { models, raw } = await client.listModels();
const perMillion = (price: bigint | null) =>
  price === null ? 'unpriced' : formatZg(price * 1_000_000n);
const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));

console.log(
  'model'.padEnd(36),
  'in 0G/1M'.padStart(14),
  'out 0G/1M'.padStart(14),
  'prov',
  'context',
);
for (const m of sorted) {
  console.log(
    m.id.padEnd(36),
    perMillion(m.promptPrice).padStart(14),
    perMillion(m.completionPrice).padStart(14),
    String(m.providerCount ?? '?').padStart(4),
    String(m.contextLength ?? '?'),
  );
}
const unpriced = sorted.filter((m) => m.pricingIssue !== null);
console.log(`\n${models.length} models.`);
for (const m of unpriced) {
  console.log(`  ${m.id}: no per-token price (${m.pricingIssue}); zg:infer refuses it.`);
}

let configuredFound: boolean | null = null;
if (configuredModel !== null) {
  configuredFound = models.some((m) => m.id === configuredModel);
  console.log(
    configuredFound
      ? `ZG_MODEL ${configuredModel}: in the catalog.`
      : `ZG_MODEL ${configuredModel}: NOT in the ${network} catalog. Pick an ID from the list above.`,
  );
}

if (hasFlag('--save-evidence')) {
  const path = writeEvidence('zg', `models-${network}`, {
    kind: 'zg-models',
    fetchedAt,
    network,
    url: `${client.baseUrl}/models`,
    count: models.length,
    configuredModel,
    configuredFound,
    models: sorted.map((m) => ({
      id: m.id,
      name: m.name,
      promptNeuronPerToken: m.promptPrice,
      completionNeuronPerToken: m.completionPrice,
      providerCount: m.providerCount,
      contextLength: m.contextLength,
      pricingIssue: m.pricingIssue,
    })),
    raw,
  });
  console.log(`Evidence written to ${path}`);
}

if (models.length === 0 || configuredFound === false) process.exitCode = 1;
