/**
 * Read-only ENS resolution on Sepolia through the Universal Resolver, using
 * viem's built-in ENS helpers (no private key needed).
 *
 *   pnpm ens:resolve                                   ENS_PARENT_NAME, keys description and url
 *   pnpm ens:resolve -- --name kev.myagents.eth --keys description,url,x-hedera-account
 *   pnpm ens:resolve -- --save-evidence
 *   pnpm ens:resolve -- --name kev.chirag126.eth --agent    all agent record keys + schema validation
 *   ... --agent --allow-local-http                          accept http://127.0.0.1 endpoints (local
 *                                                          dev, before the Render deployment)
 */
import { createPublicClient, http, normalize, sepolia } from '../../packages/ens/src/viem.ts';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  AGENT_RECORD_READ_KEYS,
  ENSV2_SEPOLIA,
  SEPOLIA_CHAIN_ID,
  parseAgentRecords,
} from '../../packages/ens/src/index.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const env = loadEnv(['ens'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia')
  throw new Error('this script reads Sepolia only (ENS_CHAIN=sepolia)');
const name = normalize(argValue('--name') ?? env.require('ENS_PARENT_NAME'));
const agentMode = hasFlag('--agent');
const allowLocalHttp = hasFlag('--allow-local-http');
const keys = agentMode
  ? [...AGENT_RECORD_READ_KEYS]
  : (argValue('--keys') ?? 'description,url')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k !== '');

const client = createPublicClient({
  chain: sepolia,
  transport: http(env.require('ETH_RPC_URL'), { timeout: 30_000 }),
});
const chainId = await client.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`ETH_RPC_URL is chain ${chainId}, not Sepolia`);

const universalResolverAddress = ENSV2_SEPOLIA.universalResolver;
const resolvedAt = new Date().toISOString();
console.log(`Resolving ${name} on Sepolia via Universal Resolver ${universalResolverAddress}\n`);

const width = Math.max('resolver'.length, ...keys.map((k) => k.length));
let resolver: string | null = null;
try {
  resolver = await client.getEnsResolver({ name, universalResolverAddress });
} catch (error) {
  console.log(
    `${'resolver'.padEnd(width)} (none: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
  );
}
if (resolver !== null) console.log(`${'resolver'.padEnd(width)} ${resolver}`);

const text: Record<string, string | null> = {};
for (const key of keys) {
  try {
    text[key] = await client.getEnsText({ name, key, universalResolverAddress });
  } catch {
    text[key] = null;
  }
  console.log(`${key.padEnd(width)} ${JSON.stringify(text[key])}`);
}

// Agent mode: validate the records against the agent record schema (D-032).
let agentValidation: ReturnType<typeof parseAgentRecords> | null = null;
if (agentMode) {
  agentValidation = parseAgentRecords(text, { allowLocalHttp });
  if (allowLocalHttp)
    console.log('\n(--allow-local-http: http endpoints on localhost are accepted)');
  console.log('\nagent record schema');
  if (agentValidation.ok) {
    console.log(
      `  VALID: status ${agentValidation.records.status}, payTo ${agentValidation.records.payTo} on ${agentValidation.records.network}`,
    );
  } else {
    for (const p of agentValidation.problems) console.log(`  ${p.code.padEnd(16)} ${p.message}`);
    console.log('  NOT a valid agent record set (discovery would skip this name).');
  }
}

if (hasFlag('--save-evidence')) {
  const path = writeEvidence('ens', 'resolution', {
    kind: 'ens-resolution',
    resolvedAt,
    chain: 'sepolia',
    chainId,
    name,
    universalResolver: universalResolverAddress,
    resolver,
    text,
    agentValidation,
    allowLocalHttp,
  });
  console.log(`\nEvidence written to ${path}`);
}

if (agentMode) {
  if (resolver === null || agentValidation?.ok !== true) process.exitCode = 1;
} else if (resolver === null || Object.values(text).some((v) => v === null)) {
  process.exitCode = 1;
}
