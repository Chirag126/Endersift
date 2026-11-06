// Class: testnet (docs/testing.md). Runs only through `pnpm test:live`, never in `pnpm test` or CI.
// Needs ETH_RPC_URL and ENS_PARENT_NAME in .env; read-only (no key, no funds).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, describe, it } from 'node:test';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  discoverProviders,
  parseDeployment,
  parseParentLabel,
  viemDiscoveryChain,
  type DiscoverySnapshot,
  type X402Network,
} from '../../packages/ens/src/index.ts';
import { createPublicClient, http, sepolia } from '../../packages/ens/src/viem.ts';
import { loadLocalEnvSource } from '../../scripts/lib/cli.ts';

const env = loadEnv(['ens', 'x402'], loadLocalEnvSource());
const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
const deployment = parseDeployment(readFileSync('deployments/sepolia.json', 'utf8'));
const client = createPublicClient({
  chain: sepolia,
  transport: http(env.require('ETH_RPC_URL'), { timeout: 30_000, retryCount: 1 }),
  batch: { multicall: true },
});
const chain = viemDiscoveryChain(client);
const options = {
  parentName: parent.name,
  parentLabel: parent.label,
  chain: 'sepolia' as const,
  expectedNetwork: env.require('X402_NETWORK') as X402Network,
};

describe('discovery against Sepolia (live)', { timeout: 180_000 }, () => {
  let local: DiscoverySnapshot;
  before(async () => {
    local = await discoverProviders(chain, { ...options, allowLocalHttp: true });
  });

  it('finds our subregistry from the parent name alone and pins one block', async () => {
    assert.equal(local.subregistry.toLowerCase(), deployment.subregistry.toLowerCase());
    assert.ok(local.blockNumber > local.fromBlock);
    assert.ok(local.logsScanned >= deployment.agents.length);
    assert.ok(local.blockNumber <= (await client.getBlockNumber()));
  });

  it('discovers every provisioned agent with exactly its published records', () => {
    for (const agent of deployment.agents) {
      const found = local.providers.find((p) => p.label === agent.label);
      assert.ok(found !== undefined, `${agent.label} not discovered`);
      assert.equal(found.name, agent.name);
      assert.equal(found.resolver.toLowerCase(), agent.resolver.toLowerCase());
      assert.equal(found.provider.endpoint, agent.records['agent.endpoint']);
      assert.equal(found.provider.payTo, agent.records['x402.payTo']);
      assert.equal(found.provider.priceAtomic, agent.records['agent.price']);
      assert.equal(found.provider.capabilities.join(','), agent.records['agent.capabilities']);
      assert.ok(
        found.registeredAtBlock >= local.fromBlock && found.registeredAtBlock <= local.blockNumber,
      );
    }
  });

  it('refuses loopback endpoints unless local mode is requested', async () => {
    const strict = await discoverProviders(chain, {
      ...options,
      allowLocalHttp: false,
      fromBlock: local.fromBlock,
    });
    for (const agent of deployment.agents) {
      const loopback = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(
        agent.records['agent.endpoint'] ?? '',
      );
      const providers = strict.providers.map((p) => p.label);
      if (loopback) {
        assert.ok(!providers.includes(agent.label), `${agent.label} accepted in strict mode`);
        const skipped = strict.skipped.find((s) => s.label === agent.label);
        assert.equal(skipped?.code, 'INVALID_RECORDS');
      } else {
        assert.ok(providers.includes(agent.label));
      }
    }
  });
});
