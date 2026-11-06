/**
 * Prove that discovery picks up a new agent without code changes (plan row 14).
 *
 *   pnpm ens:discovery-proof                              dry run: discovery + simulated deploy
 *   pnpm ens:discovery-proof -- --confirm --save-evidence
 *
 * Steps (same discoverProviders() call every time, nothing about the probe is
 * known to discovery):
 *   1. discover                                       → probe absent
 *   2. deploy a resolver for probe-<stamp> with all agent records set in its
 *      initializer, then register the label in our subregistry   (2 tx)
 *   3. discover                                       → probe present, records valid
 *   4. unregister the probe                           (1 tx)
 *   5. discover                                       → probe skipped as NOT_REGISTERED
 * kev, cve and osv must be present and unchanged in all three snapshots.
 *
 * The probe pays out to kev's account (it is never paid: it exists for a few
 * blocks and is unregistered). Its resolver stays deployed; the label stays
 * visible in the logs and is reported under `skipped` by later discoveries.
 */
import { readFileSync } from 'node:fs';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  ALL_RESOLVER_ROLES,
  ENSV2_SEPOLIA,
  REGISTRY_STATUS,
  SEPOLIA_CHAIN_ID,
  SUBNAME_TOKEN_ROLES,
  ZERO_ADDRESS,
  agentResolverSalt,
  desiredAgentText,
  discoverProviders,
  dnsEncode,
  labelId,
  parseDeployment,
  parseParentLabel,
  permissionedRegistryAbi,
  permissionedResolverAbi,
  sepoliaEtherscanTx,
  verifiableFactoryAbi,
  viemDiscoveryChain,
  type DiscoverySnapshot,
  type X402Network,
} from '../../packages/ens/src/index.ts';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  parseEther,
  privateKeyToAccount,
  sepolia,
  type Address,
  type Hash,
} from '../../packages/ens/src/viem.ts';
import {
  fileStamp,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

class DiscoveryProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryProofError';
  }
}

const MIN_ETH = parseEther('0.01');
const R = ENSV2_SEPOLIA;
const env = loadEnv(['ens-admin', 'x402'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia')
  throw new DiscoveryProofError('this script runs on Sepolia only');
const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
const admin = privateKeyToAccount(env.require('ENS_ADMIN_PRIVATE_KEY') as `0x${string}`);
const transport = http(env.require('ETH_RPC_URL'), { timeout: 30_000, retryCount: 1 });
const client = createPublicClient({ chain: sepolia, transport, batch: { multicall: true } });
const wallet = createWalletClient({ chain: sepolia, transport, account: admin });
const confirm = hasFlag('--confirm');
const network = env.require('X402_NETWORK') as X402Network;

const chainId = await client.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID)
  throw new DiscoveryProofError(`ETH_RPC_URL is chain ${chainId}, not Sepolia`);

const deployment = parseDeployment(readFileSync('deployments/sepolia.json', 'utf8'));
const provisioned = deployment.agents.map((a) => a.label).sort();
const kev = deployment.agents.find((a) => a.label === 'kev');
if (kev === undefined) throw new DiscoveryProofError('deployments/sepolia.json has no kev agent');
const registry = deployment.subregistry as Address;

const stamp = fileStamp().toLowerCase(); // e.g. 20261027t010203z
const probeLabel = `probe-${stamp}`;
const probeName = `${probeLabel}.${parent.name}`;
const probeText = desiredAgentText(
  {
    label: probeLabel,
    capabilities: ['discovery-probe'],
    priceAtomic: '100000',
    description: 'Temporary discovery probe (plan row 14); unregistered right after the test.',
    context: 'Not a real provider. Registered and unregistered by pnpm ens:discovery-proof.',
  },
  {
    endpointBase: env.require('ENS_AGENT_ENDPOINT_BASE'),
    payToByLabel: new Map([[probeLabel, kev.records['x402.payTo'] ?? '']]),
    network,
    asset: env.require('X402_ASSET'),
    maxPriceAtomic: BigInt(env.require('X402_MAX_PAYMENT_TINYBARS')),
  },
);

const chain = viemDiscoveryChain(client);
let fromBlock: bigint | undefined;
async function discover(step: string): Promise<DiscoverySnapshot> {
  const s = await discoverProviders(chain, {
    parentName: parent.name,
    parentLabel: parent.label,
    chain: 'sepolia',
    allowLocalHttp: true,
    expectedNetwork: network,
    ...(fromBlock === undefined ? {} : { fromBlock }),
  });
  fromBlock = s.fromBlock; // search the deployment block once
  console.log(
    `  [${step}] block ${s.blockNumber}: providers ${s.providers.map((p) => p.label).join(', ') || '(none)'} · skipped ${s.skipped.map((x) => `${x.label}:${x.code}`).join(', ') || '(none)'}`,
  );
  return s;
}

const startedAt = new Date().toISOString();
const txLog: { step: string; hash: Hash; url: string; block: bigint }[] = [];
async function send(
  step: string,
  request: Parameters<typeof wallet.writeContract>[0],
): Promise<bigint> {
  const hash = await wallet.writeContract(request);
  console.log(`  ${step}: sent ${hash}  ${sepoliaEtherscanTx(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success')
    throw new DiscoveryProofError(`${step} transaction ${hash} reverted`);
  txLog.push({ step, hash, url: sepoliaEtherscanTx(hash), block: receipt.blockNumber });
  console.log(`  ${step}: confirmed in block ${receipt.blockNumber}`);
  return receipt.blockNumber;
}
/** Wait until the RPC's latest block includes `block`, so the next discovery sees it. */
async function waitForHead(block: bigint): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await client.getBlockNumber({ cacheTime: 0 })) >= block) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new DiscoveryProofError(`the RPC did not reach block ${block}`);
}

console.log(
  `Discovery proof on Sepolia ${confirm ? '(CONFIRM: sending transactions)' : '(dry run)'}`,
);
console.log(`  parent       ${parent.name} · subregistry ${registry}`);
console.log(`  probe        ${probeName} (payTo ${probeText['x402.payTo']}, never paid)`);
console.log(`  admin        ${admin.address}\n`);

const s1 = await discover('1 before');
if (s1.subregistry.toLowerCase() !== registry.toLowerCase()) {
  throw new DiscoveryProofError('the chain subregistry differs from deployments/sepolia.json');
}

// Probe resolver: initialised with the admin's roles and every record in one transaction.
const salt = agentResolverSalt(probeName);
const dns = dnsEncode(probeName);
const initCalls = Object.entries(probeText).map(([key, value]) =>
  encodeFunctionData({
    abi: permissionedResolverAbi,
    functionName: 'setText',
    args: [dns, key, value],
  }),
);
const initData = encodeFunctionData({
  abi: permissionedResolverAbi,
  functionName: 'initialize',
  args: [[{ account: admin.address, roleBitmap: ALL_RESOLVER_ROLES }], initCalls],
});
const { request: deployRequest, result: predictedResolver } = await client.simulateContract({
  account: admin,
  address: R.verifiableFactory,
  abi: verifiableFactoryAbi,
  functionName: 'deployProxy',
  args: [R.permissionedResolverImpl, salt, initData],
});
const balance = await client.getBalance({ address: admin.address });
console.log(
  `\n  simulated resolver deploy → ${predictedResolver} (records set in its initializer)`,
);
console.log(
  `  admin balance ${formatEther(balance)} ETH (need ≥ ${formatEther(MIN_ETH)} with --confirm)\n`,
);

let s2: DiscoverySnapshot | null = null;
let s3: DiscoverySnapshot | null = null;
let registerBlock: bigint | null = null;
if (confirm) {
  if (balance < MIN_ETH)
    throw new DiscoveryProofError('fund the admin wallet with Sepolia ETH first');
  const parentExpiry = await client.readContract({
    address: R.ethRegistry,
    abi: permissionedRegistryAbi,
    functionName: 'getExpiry',
    args: [labelId(parent.label)],
  });
  await send('deploy probe resolver', deployRequest);
  const { request: registerRequest } = await client.simulateContract({
    account: admin,
    address: registry,
    abi: permissionedRegistryAbi,
    functionName: 'register',
    args: [
      probeLabel,
      admin.address,
      ZERO_ADDRESS,
      predictedResolver,
      SUBNAME_TOKEN_ROLES,
      parentExpiry,
    ],
  });
  registerBlock = await send('register probe', registerRequest);
  await waitForHead(registerBlock);
  s2 = await discover('2 after adding the probe');

  const { request: unregisterRequest } = await client.simulateContract({
    account: admin,
    address: registry,
    abi: permissionedRegistryAbi,
    functionName: 'unregister',
    args: [labelId(probeLabel)],
  });
  const unregisterBlock = await send('unregister probe', unregisterRequest);
  await waitForHead(unregisterBlock);
  s3 = await discover('3 after removing the probe');
  const status = await client.readContract({
    address: registry,
    abi: permissionedRegistryAbi,
    functionName: 'getStatus',
    args: [labelId(probeLabel)],
  });
  if (Number(status) === REGISTRY_STATUS.REGISTERED)
    throw new DiscoveryProofError('the probe is still registered');
}

// ── assertions ───────────────────────────────────────────────────────────
const labels = (s: DiscoverySnapshot) => s.providers.map((p) => p.label).sort();
const provisionedIntact = (s: DiscoverySnapshot) => provisioned.every((l) => labels(s).includes(l));
const probeIn2 = s2?.providers.find((p) => p.label === probeLabel) ?? null;
const checks = {
  provisionedAgentsInEverySnapshot: [s1, s2, s3].every((s) => s === null || provisionedIntact(s)),
  probeAbsentBefore: !labels(s1).includes(probeLabel),
  probeDiscoveredAfterAdding:
    probeIn2 !== null &&
    probeIn2.resolver.toLowerCase() === predictedResolver.toLowerCase() &&
    probeIn2.registeredAtBlock === registerBlock &&
    probeIn2.provider.endpoint === probeText['agent.endpoint'] &&
    probeIn2.provider.capabilities.join(',') === 'discovery-probe',
  probeGoneAfterRemoving:
    s3 !== null &&
    !labels(s3).includes(probeLabel) &&
    s3.skipped.some((x) => x.label === probeLabel && x.code === 'NOT_REGISTERED'),
  blocksAdvance:
    s2 !== null &&
    s3 !== null &&
    s1.blockNumber < s2.blockNumber &&
    s2.blockNumber < s3.blockNumber,
};
const verified = confirm && Object.values(checks).every(Boolean);
console.log('\nchecks');
for (const [k, v] of Object.entries(checks))
  console.log(`  ${v ? 'PASS' : confirm ? 'FAIL' : '----'} ${k}`);

const summary = (s: DiscoverySnapshot | null) =>
  s === null
    ? null
    : {
        blockNumber: s.blockNumber,
        blockHash: s.blockHash,
        fromBlock: s.fromBlock,
        logsScanned: s.logsScanned,
        providers: s.providers.map((p) => ({
          label: p.label,
          name: p.name,
          resolver: p.resolver,
          registeredAtBlock: p.registeredAtBlock,
          registrationTx: p.registrationTx,
          endpoint: p.provider.endpoint,
          payTo: p.provider.payTo,
          priceAtomic: p.provider.priceAtomic,
          capabilities: p.provider.capabilities,
        })),
        skipped: s.skipped,
      };

if (hasFlag('--save-evidence')) {
  const path = writeEvidence(
    'ens',
    verified ? 'discovery-proof' : confirm ? 'discovery-proof-attempt' : 'discovery-proof-dry-run',
    {
      kind: 'ens-discovery-proof',
      startedAt,
      finishedAt: new Date().toISOString(),
      chain: 'sepolia',
      chainId,
      parent: parent.name,
      subregistry: registry,
      probe: {
        label: probeLabel,
        name: probeName,
        resolver: predictedResolver,
        records: probeText,
      },
      confirm,
      transactions: txLog,
      snapshots: { before: summary(s1), afterAdding: summary(s2), afterRemoving: summary(s3) },
      checks,
      verified,
    },
  );
  console.log(`\nEvidence written to ${path}`);
}

if (verified) {
  console.log(
    `\nDISCOVERY PROOF: ${probeName} appeared in discovery at block ${s2?.blockNumber} with no code change, and was gone at block ${s3?.blockNumber} after unregistering; kev, cve and osv were discovered every time.`,
  );
} else if (confirm || !checks.probeAbsentBefore || !checks.provisionedAgentsInEverySnapshot) {
  process.exitCode = 1;
} else {
  console.log('\nDRY RUN: nothing sent. Re-run with --confirm to add and remove the probe.');
}
