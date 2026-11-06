/**
 * Register this project's agents in the ERC-8004 Identity Registry on Sepolia (D-066).
 *
 *   pnpm erc8004:register                               dry run: checks and simulations only
 *   pnpm erc8004:register -- --confirm --save-evidence
 *
 * Agents: kev, cve and osv (the providers) and `agent` (the threat-intel agent
 * itself). Each agentURI is its registration file on the deployed provider
 * service: <ENS_AGENT_ENDPOINT_BASE>/.well-known/erc-8004/<label>.json.
 *
 * Steps, per agent (idempotent: a rerun on a converged state sends nothing):
 *   1. the registration file must answer 200 with the ERC-8004 type (a
 *      registry entry never points at a dead URI);
 *   2. already recorded in deployments/sepolia-erc8004.json → read tokenURI and
 *      ownerOf on chain; a different URI is corrected with setAgentURI;
 *   3. otherwise register(agentURI), simulated first; the agentId comes from
 *      the Registered event of the mined transaction;
 *   4. every agent is read back from the chain (tokenURI, ownerOf = admin).
 * Writes deployments/sepolia-erc8004.json only from verified reads (no
 * timestamps or hashes); transaction hashes go to the evidence file.
 *
 * Signs with ENS_ADMIN_PRIVATE_KEY (the owner of the ENS names), which is
 * never deployed. The registration files list each agentId after the provider
 * service is redeployed with the updated deployment file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnv } from '../../packages/core/src/index.ts';
import { AGENTS } from '../../packages/ens/src/agents.ts';
import { SEPOLIA_CHAIN_ID, sepoliaEtherscanTx } from '../../packages/ens/src/constants.ts';
import {
  ERC8004_DEPLOYMENT_PATH,
  ERC8004_SEPOLIA,
  REGISTRATION_TYPE,
  identityRegistryAbi,
  parseErc8004Deployment,
  serializeErc8004Deployment,
  type Erc8004Agent,
} from '../../packages/ens/src/erc8004.ts';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
  privateKeyToAccount,
  sepolia,
  type Address,
  type Hash,
} from '../../packages/ens/src/viem.ts';
import { handleScriptErrors, hasFlag, loadLocalEnvSource, writeEvidence } from '../lib/cli.ts';
import { writeWithFixedNonce } from '../lib/rpc-write.ts';

handleScriptErrors();

class Erc8004Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Erc8004Error';
  }
}

const MIN_ETH = parseEther('0.005');
const env = loadEnv(['ens-admin'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia')
  throw new Erc8004Error('this script runs on Sepolia only');
const admin = privateKeyToAccount(env.require('ENS_ADMIN_PRIVATE_KEY') as `0x${string}`);
const base = env.require('ENS_AGENT_ENDPOINT_BASE').replace(/\/+$/, '');
if (!base.startsWith('https://'))
  throw new Erc8004Error(
    'ENS_AGENT_ENDPOINT_BASE must be the https URL of the deployed provider service (the agentURI host)',
  );
// reads retry an HTTP 429 with backoff; writes never do here: writeWithFixedNonce decides (D-067)
const rpcUrl = env.require('ETH_RPC_URL');
const client = createPublicClient({
  chain: sepolia,
  transport: http(rpcUrl, { timeout: 30_000, retryCount: 4, retryDelay: 1_500 }),
});
const wallet = createWalletClient({
  chain: sepolia,
  transport: http(rpcUrl, { timeout: 30_000, retryCount: 0 }),
  account: admin,
});
const pendingNonce = () =>
  client.getTransactionCount({ address: admin.address, blockTag: 'pending' });
const confirm = hasFlag('--confirm');
const registry = ERC8004_SEPOLIA.identityRegistry as Address;

const chainId = await client.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID)
  throw new Erc8004Error(`ETH_RPC_URL is chain ${chainId}, not Sepolia`);
if ((await client.getCode({ address: registry })) === undefined)
  throw new Erc8004Error(`no contract at the Identity Registry ${registry} on Sepolia`);

const recorded = existsSync(ERC8004_DEPLOYMENT_PATH)
  ? parseErc8004Deployment(JSON.parse(readFileSync(ERC8004_DEPLOYMENT_PATH, 'utf8')))
  : null;
if (existsSync(ERC8004_DEPLOYMENT_PATH) && recorded === null)
  throw new Erc8004Error(`${ERC8004_DEPLOYMENT_PATH} is malformed; fix or remove it first`);
if (recorded !== null && recorded.identityRegistry.toLowerCase() !== registry.toLowerCase())
  throw new Erc8004Error(`${ERC8004_DEPLOYMENT_PATH} names another registry`);

const labels = [...AGENTS.map((a) => a.label), 'agent'];
const uriOf = (label: string) => `${base}/.well-known/erc-8004/${label}.json`;

console.log(
  `ERC-8004 registration on Sepolia ${confirm ? '(CONFIRM: sending transactions)' : '(dry run)'}`,
);
console.log(`  Identity Registry ${registry}`);
console.log(`  owner (ENS admin) ${admin.address}\n`);

// 1. every registration file must be served before it is registered
const files: Record<string, { ok: boolean; detail: string }> = {};
for (const label of labels) {
  const uri = uriOf(label);
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(90_000), redirect: 'error' });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const ok = res.status === 200 && body?.['type'] === REGISTRATION_TYPE;
    files[label] = { ok, detail: ok ? `200, ${String(body?.['name'])}` : `HTTP ${res.status}` };
  } catch (error) {
    files[label] = { ok: false, detail: error instanceof Error ? error.name : 'unreachable' };
  }
  console.log(
    `  ${files[label]?.ok ? 'OK  ' : 'FAIL'} file ${label.padEnd(5)} ${uri} (${files[label]?.detail})`,
  );
}
if (Object.values(files).some((f) => !f.ok))
  throw new Erc8004Error(
    'a registration file is not served yet: deploy the provider service with this version first (the first request may take a minute while it wakes)',
  );

type Step =
  | { readonly kind: 'ok'; readonly label: string; readonly agent: Erc8004Agent }
  | { readonly kind: 'register'; readonly label: string; readonly uri: string }
  | {
      readonly kind: 'set-uri';
      readonly label: string;
      readonly agent: Erc8004Agent;
      readonly uri: string;
    };

// 2. plan from the chain, not from the file alone
const steps: Step[] = [];
for (const label of labels) {
  const uri = uriOf(label);
  const known = recorded?.agents[label];
  if (known === undefined) {
    steps.push({ kind: 'register', label, uri });
    continue;
  }
  const [owner, onChainUri] = await Promise.all([
    client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [BigInt(known.agentId)],
    }),
    client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'tokenURI',
      args: [BigInt(known.agentId)],
    }),
  ]);
  if (owner.toLowerCase() !== admin.address.toLowerCase())
    throw new Erc8004Error(`agent ${known.agentId} (${label}) is owned by ${owner}, not the admin`);
  steps.push(
    onChainUri === uri
      ? { kind: 'ok', label, agent: known }
      : { kind: 'set-uri', label, agent: known, uri },
  );
}
for (const s of steps)
  console.log(
    `  plan ${s.label.padEnd(5)} ${s.kind === 'ok' ? `already registered as agent ${s.agent.agentId}` : s.kind === 'register' ? 'register' : `set agentURI of agent ${s.agent.agentId}`}`,
  );

// simulate every write (a wrong address or ABI fails here, before anything is sent)
for (const s of steps) {
  if (s.kind === 'register')
    await client.simulateContract({
      account: admin,
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'register',
      args: [s.uri],
    });
  if (s.kind === 'set-uri')
    await client.simulateContract({
      account: admin,
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'setAgentURI',
      args: [BigInt(s.agent.agentId), s.uri],
    });
}
const balance = await client.getBalance({ address: admin.address });
console.log(`\n  simulations passed · admin balance ${formatEther(balance)} ETH`);

const startedAt = new Date().toISOString();
const sent: { label: string; step: string; hash: Hash; url: string; block: string }[] = [];
const agents: Record<string, Erc8004Agent> = {};
for (const s of steps) if (s.kind !== 'register') agents[s.label] = s.agent;

if (confirm && steps.some((s) => s.kind !== 'ok')) {
  if (balance < MIN_ETH)
    throw new Erc8004Error(`fund the admin with at least ${formatEther(MIN_ETH)} Sepolia ETH`);
  for (const s of steps) {
    if (s.kind === 'ok') continue;
    const hash = await writeWithFixedNonce({
      nonce: pendingNonce,
      write: (nonce) =>
        s.kind === 'register'
          ? wallet.writeContract({
              address: registry,
              abi: identityRegistryAbi,
              functionName: 'register',
              args: [s.uri],
              nonce,
            })
          : wallet.writeContract({
              address: registry,
              abi: identityRegistryAbi,
              functionName: 'setAgentURI',
              args: [BigInt(s.agent.agentId), s.uri],
              nonce,
            }),
      log: (line) => console.log(line),
    });
    console.log(`  ${s.label}: sent ${hash}  ${sepoliaEtherscanTx(hash)}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== 'success')
      throw new Erc8004Error(`${s.label}: transaction ${hash} reverted`);
    sent.push({
      label: s.label,
      step: s.kind,
      hash,
      url: sepoliaEtherscanTx(hash),
      block: receipt.blockNumber.toString(),
    });
    if (s.kind === 'register') {
      const events = parseEventLogs({
        abi: identityRegistryAbi,
        eventName: 'Registered',
        logs: receipt.logs,
      });
      const mine = events.filter((e) => e.address.toLowerCase() === registry.toLowerCase());
      const ev = mine[0];
      if (mine.length !== 1 || ev === undefined)
        throw new Erc8004Error(`${s.label}: no single Registered event in ${hash}`);
      agents[s.label] = {
        agentId: ev.args.agentId.toString(),
        agentURI: s.uri,
        owner: admin.address,
      };
      console.log(`  ${s.label}: agent ${ev.args.agentId} (block ${receipt.blockNumber})`);
    } else {
      agents[s.label] = { ...s.agent, agentURI: s.uri };
    }
  }
}

// 4. verify every agent from the chain
const checks: { label: string; agentId: string; owner: boolean; uri: boolean }[] = [];
for (const [label, a] of Object.entries(agents)) {
  const [owner, uri] = await Promise.all([
    client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [BigInt(a.agentId)],
    }),
    client.readContract({
      address: registry,
      abi: identityRegistryAbi,
      functionName: 'tokenURI',
      args: [BigInt(a.agentId)],
    }),
  ]);
  checks.push({
    label,
    agentId: a.agentId,
    owner: owner.toLowerCase() === admin.address.toLowerCase(),
    uri: uri === uriOf(label),
  });
}
const complete = labels.every((l) => agents[l] !== undefined);
const verified = complete && checks.every((c) => c.owner && c.uri);
console.log('\nchecks');
for (const c of checks)
  console.log(
    `  ${c.owner && c.uri ? 'PASS' : 'FAIL'} ${c.label} agent ${c.agentId} (owner ${c.owner}, agentURI ${c.uri})`,
  );
if (!complete)
  console.log(`  ---- not every agent is registered yet${confirm ? '' : ' (dry run)'}`);

if (verified) {
  const text = serializeErc8004Deployment({
    kind: 'erc8004-deployment',
    version: 1,
    chainId: ERC8004_SEPOLIA.chainId,
    identityRegistry: registry,
    agents,
  });
  const before = existsSync(ERC8004_DEPLOYMENT_PATH)
    ? readFileSync(ERC8004_DEPLOYMENT_PATH, 'utf8')
    : '';
  if (text !== before) writeFileSync(ERC8004_DEPLOYMENT_PATH, text, 'utf8');
  console.log(`\n${ERC8004_DEPLOYMENT_PATH} ${text === before ? 'unchanged' : 'written'}`);
}

if (hasFlag('--save-evidence')) {
  const path = writeEvidence(
    'identity',
    verified ? 'erc8004-register' : 'erc8004-register-attempt',
    {
      kind: 'erc8004-registration',
      startedAt,
      finishedAt: new Date().toISOString(),
      chainId: ERC8004_SEPOLIA.chainId,
      identityRegistry: registry,
      owner: admin.address,
      files,
      plan: steps.map((s) => ({ label: s.label, kind: s.kind })),
      sentThisRun: sent,
      agents,
      checks,
      verified,
    },
  );
  console.log(`Evidence written to ${path}`);
}
console.log(
  verified
    ? '\nVERIFIED: every agent is registered and reads back correctly.'
    : '\nNOT VERIFIED: see above.',
);
if (!verified && confirm) process.exitCode = 1;
