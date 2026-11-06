/**
 * Give the parent name a subregistry and create one subname with its own
 * resolver and records, then resolve it through the Universal Resolver.
 *
 *   pnpm ens:subname                               dry run for kev.<ENS_PARENT_NAME>
 *   pnpm ens:subname -- --label kev --confirm --save-evidence
 *   pnpm ens:subname -- --registry 0x...           adopt a subregistry you already deployed
 *
 * Steps (packages/ens/src/plan-subname.ts):
 *   DEPLOY_REGISTRY      UserRegistry proxy via the VerifiableFactory, root roles to you
 *   SET_SUBREGISTRY      ETHRegistry.setSubregistry(labelhash(parent), registry)  (your .eth token role)
 *   SET_PARENT           registry.setParent(ETHRegistry, parentLabel)              (canonical path)
 *   DEPLOY_SUB_RESOLVER  a PermissionedResolver just for this subname
 *   REGISTER_SUBNAME     registry.register(label, you, 0, resolver, roles, parentExpiry)
 *   SET_SUB_RESOLVER     only if the subname points elsewhere
 *   SET_TEXT             resolver.setText(dnsName(sub), key, value)
 *
 * Same safety model as ens:register: Sepolia only, simulate before send, hashes
 * saved as sent (resumable), no keys or RPC URL printed.
 */
import { join } from 'node:path';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  ALL_RESOLVER_ROLES,
  ENSV2_SEPOLIA,
  SEPOLIA_CHAIN_ID,
  SUBNAME_TOKEN_ROLES,
  USER_REGISTRY_ROOT_ROLES,
  ZERO_ADDRESS,
  agentResolverSalt,
  dnsEncode,
  isSubnameTerminal,
  labelId,
  loadSubname,
  newSubname,
  nextSubnameStep,
  parseChildLabel,
  parseParentLabel,
  permissionedRegistryAbi,
  permissionedResolverAbi,
  saveSubname,
  sepoliaEtherscanAddress,
  sepoliaEtherscanTx,
  userRegistrySalt,
  verifiableFactoryAbi,
  type StoredSubname,
  type SubnameFacts,
  type SubnameStep,
} from '../../packages/ens/src/index.ts';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  parseEventLogs,
  privateKeyToAccount,
  sepolia,
  type Address,
  type Hash,
} from '../../packages/ens/src/viem.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const REPO_URL = 'https://github.com/Chirag126/-hedera-ens-0g-agent-economy';
const MIN_ETH = 5n * 10n ** 15n; // 0.005 Sepolia ETH

const env = loadEnv(['ens-admin'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia')
  throw new Error('this script runs on Sepolia only (ENS_CHAIN=sepolia)');
const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
const label = parseChildLabel(argValue('--label') ?? 'kev');
const fullName = `${label}.${parent.name}`;
const account = privateKeyToAccount(env.require('ENS_ADMIN_PRIVATE_KEY') as `0x${string}`);
const transport = http(env.require('ETH_RPC_URL'), { timeout: 30_000, retryCount: 1 });
const client = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });
const confirm = hasFlag('--confirm');
const registryOverride = argValue('--registry');
const R = ENSV2_SEPOLIA;

const DESIRED_TEXT: Record<string, string> = {
  description: `Provider agent "${label}" under ${parent.name} (Hedera x ENSv2 x 0G agent economy, Sepolia).`,
  url: REPO_URL,
};

const chainId = await client.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`ETH_RPC_URL is chain ${chainId}, not Sepolia`);

const statePath = join('.secrets', `ens-subname-${label}.${parent.label}.json`);
const expected = { chainId, parent: parent.name, label, owner: account.address };
let state: StoredSubname = loadSubname(statePath, expected) ?? newSubname(expected);
if (registryOverride !== undefined) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(registryOverride))
    throw new Error('--registry must be an address');
  state = { ...state, registry: registryOverride };
}
saveSubname(statePath, state);
const update = (patch: Partial<StoredSubname>) => {
  state = { ...state, ...patch };
  saveSubname(statePath, state);
};

const startedAt = new Date().toISOString();
const txLog: { step: string; hash: Hash; url: string }[] = [];

console.log(
  `ENSv2 subregistry + subname on Sepolia ${confirm ? '(CONFIRM: sending transactions)' : '(dry run: read-only)'}`,
);
console.log(`  subname      ${fullName}`);
console.log(`  parent       ${parent.name}`);
console.log(`  owner        ${account.address}`);
console.log(`  state file   ${statePath} (gitignored)\n`);

async function readText(key: string): Promise<string | null> {
  try {
    return await client.getEnsText({
      name: fullName,
      key,
      universalResolverAddress: R.universalResolver,
    });
  } catch {
    return null;
  }
}

async function gatherFacts(): Promise<SubnameFacts> {
  const [ethBalance, block, parentExpiry, parentSubregistry] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.getBlock({ blockTag: 'latest' }),
    client.readContract({
      address: R.ethRegistry,
      abi: permissionedRegistryAbi,
      functionName: 'getExpiry',
      args: [labelId(parent.label)],
    }),
    client.readContract({
      address: R.ethRegistry,
      abi: permissionedRegistryAbi,
      functionName: 'getSubregistry',
      args: [parent.label],
    }),
  ]);
  let registryParent: SubnameFacts['registryParent'] = null;
  let subExpiry = 0n;
  let subResolverOnChain: string = ZERO_ADDRESS;
  if (state.registry !== null) {
    const reg = state.registry as Address;
    const [[p, l], exp, res] = await Promise.all([
      client.readContract({
        address: reg,
        abi: permissionedRegistryAbi,
        functionName: 'getParent',
      }),
      client.readContract({
        address: reg,
        abi: permissionedRegistryAbi,
        functionName: 'getExpiry',
        args: [labelId(label)],
      }),
      client.readContract({
        address: reg,
        abi: permissionedRegistryAbi,
        functionName: 'getResolver',
        args: [label],
      }),
    ]);
    registryParent = { parent: p, label: l };
    subExpiry = exp;
    subResolverOnChain = res;
  }
  const currentText: Record<string, string | null> = {};
  if (subExpiry > block.timestamp) {
    for (const key of Object.keys(DESIRED_TEXT)) currentText[key] = await readText(key);
  }
  return {
    ethBalance,
    minEth: MIN_ETH,
    now: block.timestamp,
    parentExpiry,
    parentSubregistry,
    ethRegistry: R.ethRegistry,
    parentLabel: parent.label,
    registryParent,
    subExpiry,
    subResolverOnChain,
    desiredText: DESIRED_TEXT,
    currentText,
  };
}

async function send(
  step: string,
  request: Parameters<typeof wallet.writeContract>[0],
  record: (h: Hash) => void,
) {
  const hash = await wallet.writeContract(request);
  record(hash);
  txLog.push({ step, hash, url: sepoliaEtherscanTx(hash) });
  console.log(`  sent ${hash}  ${sepoliaEtherscanTx(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new Error(`${step} transaction ${hash} reverted`);
  console.log(`  confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function deployProxy(
  step: string,
  implementation: Address,
  salt: bigint,
  data: `0x${string}`,
  record: (h: Hash) => void,
) {
  const { request, result: predicted } = await client.simulateContract({
    account,
    address: R.verifiableFactory,
    abi: verifiableFactoryAbi,
    functionName: 'deployProxy',
    args: [implementation, salt, data],
  });
  const receipt = await send(step, request, record);
  const log = parseEventLogs({
    abi: verifiableFactoryAbi,
    eventName: 'ProxyDeployed',
    logs: receipt.logs,
  })[0];
  const proxy = log?.args.proxyAddress ?? predicted;
  if (proxy.toLowerCase() !== predicted.toLowerCase())
    throw new Error(`${step}: deployed proxy differs from the simulated address`);
  console.log(`  proxy ${proxy}  ${sepoliaEtherscanAddress(proxy)}`);
  return proxy;
}

async function execute(step: SubnameStep, facts: SubnameFacts): Promise<void> {
  const owner = account.address;
  switch (step.kind) {
    case 'DEPLOY_REGISTRY': {
      const data = encodeFunctionData({
        abi: permissionedRegistryAbi,
        functionName: 'initialize',
        args: [[{ account: owner, roleBitmap: USER_REGISTRY_ROOT_ROLES }]],
      });
      const proxy = await deployProxy(
        'DEPLOY_REGISTRY',
        R.userRegistryImpl,
        userRegistrySalt(parent.name),
        data,
        (h) => update({ registryTx: h }),
      );
      update({ registry: proxy });
      return;
    }
    case 'SET_SUBREGISTRY': {
      const { request } = await client.simulateContract({
        account,
        address: R.ethRegistry,
        abi: permissionedRegistryAbi,
        functionName: 'setSubregistry',
        args: [labelId(parent.label), state.registry as Address],
      });
      await send('SET_SUBREGISTRY', request, (h) => update({ setSubregistryTx: h }));
      return;
    }
    case 'SET_PARENT': {
      const { request } = await client.simulateContract({
        account,
        address: state.registry as Address,
        abi: permissionedRegistryAbi,
        functionName: 'setParent',
        args: [R.ethRegistry, parent.label],
      });
      await send('SET_PARENT', request, (h) => update({ setParentTx: h }));
      return;
    }
    case 'DEPLOY_SUB_RESOLVER': {
      const data = encodeFunctionData({
        abi: permissionedResolverAbi,
        functionName: 'initialize',
        args: [[{ account: owner, roleBitmap: ALL_RESOLVER_ROLES }], []],
      });
      const proxy = await deployProxy(
        'DEPLOY_SUB_RESOLVER',
        R.permissionedResolverImpl,
        agentResolverSalt(fullName),
        data,
        (h) => update({ subResolverTx: h }),
      );
      update({ subResolver: proxy });
      return;
    }
    case 'REGISTER_SUBNAME': {
      const { request } = await client.simulateContract({
        account,
        address: state.registry as Address,
        abi: permissionedRegistryAbi,
        functionName: 'register',
        args: [
          label,
          owner,
          ZERO_ADDRESS,
          state.subResolver as Address,
          SUBNAME_TOKEN_ROLES,
          facts.parentExpiry,
        ],
      });
      await send('REGISTER_SUBNAME', request, (h) => update({ registerTx: h }));
      return;
    }
    case 'SET_SUB_RESOLVER': {
      const { request } = await client.simulateContract({
        account,
        address: state.registry as Address,
        abi: permissionedRegistryAbi,
        functionName: 'setResolver',
        args: [labelId(label), state.subResolver as Address],
      });
      await send('SET_SUB_RESOLVER', request, (h) => update({ setResolverTx: h }));
      return;
    }
    case 'SET_TEXT': {
      const key = step.key ?? '';
      const { request } = await client.simulateContract({
        account,
        address: state.subResolver as Address,
        abi: permissionedResolverAbi,
        functionName: 'setText',
        args: [dnsEncode(fullName), key, DESIRED_TEXT[key] ?? ''],
      });
      await send(`SET_TEXT ${key}`, request, (h) =>
        update({ textTxs: { ...state.textTxs, [key]: h } }),
      );
      return;
    }
    default:
      return;
  }
}

let facts = await gatherFacts();
console.log('preflight');
console.log(
  `  ETH balance        ${formatEther(facts.ethBalance)} (need ≥ ${formatEther(MIN_ETH)})`,
);
console.log(
  `  parent expiry      ${facts.parentExpiry > 0n ? new Date(Number(facts.parentExpiry) * 1000).toISOString() : '(not registered)'}`,
);
console.log(`  parent subregistry ${facts.parentSubregistry}`);
console.log(`  our subregistry    ${state.registry ?? '(none yet)'}`);
console.log(`  subname resolver   ${state.subResolver ?? '(none yet)'}\n`);

let step = nextSubnameStep(facts, state);
let guard = 0;
while (!isSubnameTerminal(step.kind)) {
  console.log(
    `next: ${step.kind}${step.key === undefined ? '' : ` (${step.key})`} — ${step.reason}`,
  );
  if (!confirm) {
    console.log('\nDRY RUN: nothing sent. Re-run with --confirm to execute the steps.');
    break;
  }
  if (++guard > 20) throw new Error('too many steps; stopping (state is saved; re-run to resume)');
  await execute(step, facts);
  facts = await gatherFacts();
  step = nextSubnameStep(facts, state);
}
if (isSubnameTerminal(step.kind)) console.log(`\n${step.kind}: ${step.reason}`);

// Independent read-back: the resolution path, then viem's ENS helpers via the Universal Resolver.
let resolution: {
  path: { ethRegistrySubregistry: string; subregistryResolver: string };
  resolver: string;
  text: Record<string, string | null>;
  matches: boolean;
} | null = null;
if (step.kind === 'DONE') {
  const [ethRegistrySubregistry, subregistryResolver, resolver] = await Promise.all([
    client.readContract({
      address: R.ethRegistry,
      abi: permissionedRegistryAbi,
      functionName: 'getSubregistry',
      args: [parent.label],
    }),
    client.readContract({
      address: state.registry as Address,
      abi: permissionedRegistryAbi,
      functionName: 'getResolver',
      args: [label],
    }),
    client.getEnsResolver({ name: fullName, universalResolverAddress: R.universalResolver }),
  ]);
  const text: Record<string, string | null> = {};
  for (const key of Object.keys(DESIRED_TEXT)) text[key] = await readText(key);
  const matches =
    ethRegistrySubregistry.toLowerCase() === (state.registry ?? '').toLowerCase() &&
    subregistryResolver.toLowerCase() === (state.subResolver ?? '').toLowerCase() &&
    resolver.toLowerCase() === (state.subResolver ?? '').toLowerCase() &&
    Object.entries(DESIRED_TEXT).every(([k, v]) => text[k] === v);
  resolution = { path: { ethRegistrySubregistry, subregistryResolver }, resolver, text, matches };
  console.log('\nresolution');
  console.log(`  ETHRegistry.getSubregistry("${parent.label}")  ${ethRegistrySubregistry}`);
  console.log(`  subregistry.getResolver("${label}")           ${subregistryResolver}`);
  console.log(`  Universal Resolver → resolver           ${resolver}`);
  for (const [k, v] of Object.entries(text)) console.log(`  ${k.padEnd(11)}${JSON.stringify(v)}`);
}

if (hasFlag('--save-evidence')) {
  const path = writeEvidence(
    'ens',
    resolution?.matches === true ? `subname-${label}` : `subname-${label}-attempt`,
    {
      kind: 'ens-subname',
      startedAt,
      finishedAt: new Date().toISOString(),
      chain: 'sepolia',
      chainId,
      name: fullName,
      parent: parent.name,
      owner: account.address,
      contracts: {
        ethRegistry: R.ethRegistry,
        universalResolver: R.universalResolver,
        userRegistryImpl: R.userRegistryImpl,
        permissionedResolverImpl: R.permissionedResolverImpl,
        verifiableFactory: R.verifiableFactory,
      },
      subregistry: state.registry,
      subnameResolver: state.subResolver,
      subnameExpiry: facts.subExpiry,
      roles: { subregistryRoot: USER_REGISTRY_ROOT_ROLES, subnameToken: SUBNAME_TOKEN_ROLES },
      transactions: {
        deploySubregistry: state.registryTx,
        setSubregistry: state.setSubregistryTx,
        setParent: state.setParentTx,
        deploySubnameResolver: state.subResolverTx,
        registerSubname: state.registerTx,
        setResolver: state.setResolverTx,
        setText: state.textTxs,
      },
      sentThisRun: txLog,
      finalStep: step,
      resolution,
      verified: resolution?.matches === true,
    },
  );
  console.log(`\nEvidence written to ${path}`);
}

if (resolution?.matches === true) {
  console.log(
    `\nSUBNAME RESOLVED: ${fullName} resolves through the Universal Resolver via ${parent.name}'s subregistry to its own resolver, with the records we set.`,
  );
} else if (!(step.kind !== 'DONE' && !confirm)) {
  process.exitCode = 1;
}
