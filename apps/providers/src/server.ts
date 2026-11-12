/**
 * Start the x402-protected threat-intel service (plan rows 15–16): on 127.0.0.1,
 * or on all interfaces when NODE_ENV=production (Render, D-062).
 *
 *   pnpm providers:start
 *   pnpm providers:start -- --skip-ens-check      development only; refused when NODE_ENV=production
 *
 * Startup (startup.ts): facilitators from env are probed (primary, then
 * fallback); the agents' live ENS records are read from Sepolia and must match
 * this service's price, payTo, network, asset and endpoint, or the service
 * refuses to start; then the facilitator is bound and the port opens.
 *
 * Routes, under each agent's ENS endpoint (<PROVIDERS_PUBLIC_URL>/v1/<label>):
 *   GET /v1/kev/recent?since=YYYY-MM-DD&limit=N     CISA KEV
 *   GET /v1/cve/lookup?ids=CVE-…                     NVD CVE API 2.0
 *   GET /v1/osv/query?ecosystem=…&package=…          OSV.dev
 *   GET /v1/<label>                                  free description (operation, price, payTo)
 *   GET /v1/<label>/ping                             Phase 3 settlement check
 */
import { serve } from '@hono/node-server';
import { isLoopbackHttpUrl } from '@agent-economy/core/domain';
import { loadEnv } from '@agent-economy/core';
import {
  discoverProviders,
  parseParentLabel,
  viemDiscoveryChain,
  type X402Network,
} from '@agent-economy/ens';
import { createPublicClient, http, sepolia } from '@agent-economy/ens/viem';
import { formatHbar } from '@agent-economy/hedera';
import { facilitatorsFromEnv } from '@agent-economy/hedera/x402-server';
import { GuardReader, NearRpc, formatNear } from '@agent-economy/near';
import { readFileSync } from 'node:fs';
import { AGENTS } from '@agent-economy/ens/agents';
import {
  ERC8004_DEPLOYMENT_PATH,
  ERC8004_SEPOLIA,
  parseErc8004Deployment,
} from '@agent-economy/ens/erc8004';
import { handleScriptErrors, hasFlag, loadLocalEnvSource } from '../../../scripts/lib/cli.ts';
import { loadIntelConfig, loadNearLaneConfig } from './config.ts';
import { KevFeed } from './feeds/kev.ts';
import { NvdClient } from './feeds/nvd.ts';
import { OsvClient } from './feeds/osv.ts';
import { OPERATIONS, operationPath } from './operations.ts';
import { toPublicRequest } from './public-url.ts';
import { prepareProviderService } from './startup.ts';

handleScriptErrors();

const source = loadLocalEnvSource();
const config = loadIntelConfig(source);
const skipEns = hasFlag('--skip-ens-check');

let discover: Parameters<typeof prepareProviderService>[0]['discover'] = null;
if (!skipEns) {
  const env = loadEnv(['ens'], source);
  if (env.require('ENS_CHAIN') !== 'sepolia')
    throw new Error('the ENS check runs on Sepolia (ENS_CHAIN=sepolia)');
  const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
  const fromBlock = env.get('ENS_DISCOVERY_FROM_BLOCK');
  const client = createPublicClient({
    chain: sepolia,
    // read-only client: back off and retry on 429 and 5xx (1, 2, 4, 8 s; Retry-After when sent).
    // Free RPC plans refuse bursts per second, as on the first Render start (D-063). Scripts that
    // send transactions keep a single attempt.
    transport: http(env.require('ETH_RPC_URL'), {
      timeout: 30_000,
      retryCount: 4,
      retryDelay: 1_000,
    }),
    batch: { multicall: true },
  });
  discover = () =>
    discoverProviders(viemDiscoveryChain(client), {
      parentName: parent.name,
      parentLabel: parent.label,
      chain: 'sepolia',
      allowLocalHttp: isLoopbackHttpUrl(`${config.publicUrl}/`),
      expectedNetwork: config.network as X402Network,
      // the subregistry's first block: every cold start (Render free) skips the deployment search
      ...(fromBlock === undefined ? {} : { fromBlock: BigInt(fromBlock) }),
      // free RPC plans limit requests per second (D-059)
      minLogIntervalMs: 200,
    });
}

// ERC-8004 registration files (D-066): the parent name and agent IDs come from the committed,
// verified deployment record; an agent not registered yet is served without an ID
const identity = (() => {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readFileSync('deployments/sepolia.json', 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
  const parent = record['parent'];
  if (typeof parent !== 'string') return undefined;
  let erc: ReturnType<typeof parseErc8004Deployment> = null;
  try {
    erc = parseErc8004Deployment(JSON.parse(readFileSync(ERC8004_DEPLOYMENT_PATH, 'utf8')));
  } catch {
    erc = null; // no agent registered yet
  }
  return {
    publicUrl: config.publicUrl,
    parent,
    chainId: erc?.chainId ?? ERC8004_SEPOLIA.chainId,
    identityRegistry: erc?.identityRegistry ?? ERC8004_SEPOLIA.identityRegistry,
    agentIds: Object.fromEntries(
      Object.entries(erc?.agents ?? {}).map(([label, a]) => [label, a.agentId]),
    ),
    descriptions: Object.fromEntries(AGENTS.map((a) => [a.label, a.description])),
    agentUrl: config.agentUrl,
  };
})();

// the NEAR pay lane: on only when NEAR_GUARD_CONTRACT_ID is set
const nearConfig = loadNearLaneConfig(source);
const nearGuard =
  nearConfig === null
    ? null
    : new GuardReader(new NearRpc({ url: nearConfig.nodeUrl }), nearConfig.guard);

console.log('x402 threat-intel providers: starting');
const { service, report } = await prepareProviderService({
  ...(identity === undefined ? {} : { identity }),
  ...(nearConfig === null || nearGuard === null
    ? {}
    : {
        near: {
          network: nearConfig.network,
          guard: nearConfig.guard,
          priceYocto: nearConfig.priceYocto,
          accounts: nearConfig.accounts,
          receipt: (id: number) => nearGuard.receipt(id),
        },
      }),
  config,
  facilitators: facilitatorsFromEnv(config.facilitatorUrl, config.fallbackFacilitatorUrl),
  discover,
  feeds: {
    kev: new KevFeed(),
    nvd: new NvdClient(config.nvdApiKey === undefined ? {} : { apiKey: config.nvdApiKey }),
    osv: new OsvClient(),
  },
});

for (const f of report.facilitators) {
  const state =
    f === report.bound ? 'BOUND' : f.ok ? 'standby' : `unavailable (${f.error ?? 'error'})`;
  console.log(
    `  facilitator ${f.role.padEnd(8)} ${f.url} · ${state}${f.feePayer === null ? '' : ` · fee payer ${f.feePayer}`}`,
  );
}
console.log(
  report.ens.checked
    ? `  ENS check   OK: ${report.ens.agents.join(', ')} match their live records (block ${report.ens.blockNumber}, subregistry ${report.ens.subregistry})`
    : `  ENS check   WARNING: ${report.ens.reason}`,
);

// all interfaces only in production (the host's router, e.g. Render, forwards to it); local: loopback
const hostname = config.production ? '0.0.0.0' : '127.0.0.1';
// the app sees each request on its public https URL, so x402 quotes name the ENS endpoint (D-062)
const fetchPublic = (request: Request) =>
  service.app.fetch(toPublicRequest(request, config.publicUrl));
serve({ fetch: fetchPublic, hostname, port: config.port }, (info) => {
  const base = `http://${hostname}:${info.port}`;
  console.log(`\nlistening on ${base} (${config.network}); public URL ${config.publicUrl}\n`);
  for (const p of config.providers) {
    const op = OPERATIONS[p.label];
    if (op === undefined) continue;
    console.log(`  ${p.label.padEnd(4)} GET ${base}${operationPath(p.label, op.name)}`);
    console.log(
      `       price ${p.priceAtomic} tinybars (${formatHbar(BigInt(p.priceAtomic))} HBAR) → payTo ${p.payTo}`,
    );
  }
  if (config.briefSale !== null)
    console.log(
      `  agent GET ${base}/v1/agent/brief\n       price ${config.briefSale.priceTinybars} tinybars → payTo ${config.briefSale.payTo} (the agent's earnings account)`,
    );
  if (identity !== undefined)
    console.log(
      `  ERC-8004 registration files: ${base}/.well-known/erc-8004/<label>.json (${Object.keys(identity.agentIds).length} registered)`,
    );
  if (nearConfig !== null)
    console.log(
      `  NEAR lane: ${base}/near/v1/<label>/<operation> · ${formatNear(nearConfig.priceYocto)} NEAR per request · guard ${nearConfig.guard} (${nearConfig.network})`,
    );
  console.log(
    `\n  NVD: ${config.nvdApiKey === undefined ? '5 requests / 30 s (no API key)' : '50 requests / 30 s (API key set)'}`,
  );
  console.log('Press Ctrl+C to stop.');
});
