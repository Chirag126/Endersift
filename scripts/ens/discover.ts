/**
 * Discover provider agents from chain state only (plan row 14).
 *
 *   pnpm ens:discover -- --allow-local-http                   local endpoints accepted (before deployment)
 *   pnpm ens:discover -- --allow-local-http --save-evidence
 *   pnpm ens:discover -- --from-block 11999700 --json          skip the deployment-block search; print JSON
 *
 * Input: ENS_PARENT_NAME only. Pipeline: ETHRegistry.getSubregistry(parent) →
 * LabelRegistered logs → registry status → Universal Resolver → strict record
 * parser → zod ProviderAgent, all at one pinned block. deployments/sepolia.json
 * is NOT an input; it is compared afterwards as a consistency check only.
 * Read-only: no private key is loaded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  SEPOLIA_CHAIN_ID,
  discoverProviders,
  parseDeployment,
  parseParentLabel,
  viemDiscoveryChain,
  type X402Network,
} from '../../packages/ens/src/index.ts';
import { createPublicClient, http, sepolia } from '../../packages/ens/src/viem.ts';
import {
  argValue,
  evidenceJson,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const env = loadEnv(['ens', 'x402'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia')
  throw new Error('this script runs on Sepolia only (ENS_CHAIN=sepolia)');
const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
const client = createPublicClient({
  chain: sepolia,
  transport: http(env.require('ETH_RPC_URL'), { timeout: 30_000, retryCount: 1 }),
  batch: { multicall: true },
});
const chainId = await client.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`ETH_RPC_URL is chain ${chainId}, not Sepolia`);

const fromArg = argValue('--from-block');
if (fromArg !== undefined && !/^\d+$/.test(fromArg))
  throw new Error('--from-block must be a block number');
const allowLocalHttp = hasFlag('--allow-local-http');
const startedAt = new Date().toISOString();

const snapshot = await discoverProviders(viemDiscoveryChain(client), {
  parentName: parent.name,
  parentLabel: parent.label,
  chain: 'sepolia',
  allowLocalHttp,
  expectedNetwork: env.require('X402_NETWORK') as X402Network,
  ...(fromArg === undefined ? {} : { fromBlock: BigInt(fromArg) }),
});

if (hasFlag('--json')) {
  console.log(evidenceJson(snapshot));
} else {
  console.log(
    `Discovery for ${snapshot.parent} on Sepolia${allowLocalHttp ? ' (local http endpoints accepted)' : ''}`,
  );
  console.log(`  subregistry   ${snapshot.subregistry}`);
  console.log(`  block         ${snapshot.blockNumber} (${snapshot.blockHash})`);
  console.log(
    `  logs          ${snapshot.logsScanned} LabelRegistered from block ${snapshot.fromBlock} · ${snapshot.labelsSeen} labels\n`,
  );
  console.log(`providers (${snapshot.providers.length})`);
  for (const p of snapshot.providers) {
    console.log(
      `  ${p.name.padEnd(26)} payTo ${p.provider.payTo.padEnd(14)} price ${p.provider.priceAtomic.padStart(7)} · ${p.provider.capabilities.join(',')}`,
    );
    console.log(
      `  ${''.padEnd(26)} ${p.provider.endpoint} · resolver ${p.resolver} · registered in block ${p.registeredAtBlock}`,
    );
  }
  console.log(`\nskipped (${snapshot.skipped.length})`);
  for (const s of snapshot.skipped)
    console.log(`  ${s.label.padEnd(26)} ${s.code.padEnd(24)} ${s.reason}`);
}

// Consistency check against the committed deployment (informational; not an input).
let deploymentCheck: { path: string; missing: string[]; extra: string[] } | null = null;
const deploymentPath = 'deployments/sepolia.json';
if (existsSync(deploymentPath)) {
  const deployment = parseDeployment(readFileSync(deploymentPath, 'utf8'));
  const found = new Set(snapshot.providers.map((p) => p.label));
  const expected = new Set(deployment.agents.map((a) => a.label));
  deploymentCheck = {
    path: deploymentPath,
    missing: [...expected].filter((l) => !found.has(l)),
    extra: [...found].filter((l) => !expected.has(l)),
  };
  if (!hasFlag('--json')) {
    console.log(
      `\n${deploymentPath}: ${deploymentCheck.missing.length === 0 ? 'every provisioned agent discovered' : `NOT discovered: ${deploymentCheck.missing.join(', ')}`}${deploymentCheck.extra.length === 0 ? '' : `; also discovered (not provisioned by this repo): ${deploymentCheck.extra.join(', ')}`}`,
    );
  }
}

if (hasFlag('--save-evidence')) {
  const path = writeEvidence('ens', 'discovery', {
    kind: 'ens-discovery',
    startedAt,
    finishedAt: new Date().toISOString(),
    chain: 'sepolia',
    chainId,
    snapshot,
    deploymentCheck,
  });
  console.log(`\nEvidence written to ${path}`);
}

if (snapshot.providers.length === 0) {
  console.log('\nNo valid providers discovered.');
  process.exitCode = 1;
}
