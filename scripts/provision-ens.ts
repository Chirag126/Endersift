/**
 * Provision the provider agents (plan row 12): kev, cve and osv under
 * ENS_PARENT_NAME, each with its own PermissionedResolver, the full agent
 * record set, and a per-agent operator holding SET_TEXT on that agent's
 * delegated keys only. Writes deployments/sepolia.json from verified chain
 * state.
 *
 *   pnpm ens:provision                              dry run: reads the chain, prints the plan
 *   pnpm ens:provision -- --confirm --save-evidence
 *   (run the same command again: it sends nothing and leaves the file unchanged)
 *
 * Idempotent by construction: every fact comes from chain state, never from a
 * local progress file.
 *   - Addresses: VerifiableFactory.predictProxyAddress(admin, salt) with the
 *     same salts ens:subname used, so the existing subregistry and kev's
 *     resolver are adopted, and a crash after a deploy resumes cleanly.
 *   - Control: hasRootRoles(...) of the admin on each contract.
 *   - Records: one resolver.resolve(name, multicall(text...)) read per agent.
 *   - Roles: roles(resource(key), operator) per record key, plus root.
 * Writes are batched: all differing records of an agent in one multicall,
 * all role changes in another.
 *
 * Safety: Sepolia only; simulate before send; never overwrites a subregistry
 * or resolver it does not control; operator keys are written to .secrets/
 * (gitignored) before any role is granted and are never printed.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadEnv, parseLabelledAccounts } from '../packages/core/src/index.ts';
import {
  AGENTS,
  AGENT_RECORD_SPEC,
  ALL_RESOLVER_ROLES,
  ENSV2_SEPOLIA,
  REGISTRY_ROLES,
  RESOLVER_ROLES,
  SEPOLIA_CHAIN_ID,
  SUBNAME_TOKEN_ROLES,
  USER_REGISTRY_ROOT_ROLES,
  ZERO_ADDRESS,
  AgentManifestError,
  agentResolverSalt,
  desiredAgentText,
  dnsEncode,
  isProvisionTerminal,
  labelId,
  loadOperatorKeyFile,
  missingPayoutLabels,
  nextProvisionStep,
  parseAgentRecords,
  parseDeployment,
  parseParentLabel,
  permissionedRegistryAbi,
  permissionedResolverAbi,
  publishedRecords,
  sameDeployment,
  saveOperatorKeyFile,
  sepoliaEtherscanAddress,
  sepoliaEtherscanTx,
  serializeDeployment,
  textKeyResource,
  textResolverAbi,
  userRegistrySalt,
  verifiableFactoryAbi,
  type AgentFacts,
  type Deployment,
  type OperatorKeyFile,
  type ProvisionFacts,
  type ProvisionStep,
  type X402Network,
} from '../packages/ens/src/index.ts';
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeFunctionData,
  formatEther,
  generatePrivateKey,
  http,
  namehash,
  parseEventLogs,
  privateKeyToAccount,
  sepolia,
  type Address,
  type Hash,
} from '../packages/ens/src/viem.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from './lib/cli.ts';

handleScriptErrors();

class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

const MIN_ETH = 10n ** 16n; // 0.01 Sepolia ETH
const DEPLOYMENT_PATH = argValue('--deployment') ?? 'deployments/sepolia.json';
const OPERATOR_KEY_PATH = '.secrets/ens-operator-keys.json';
const R = ENSV2_SEPOLIA;
const RECORD_KEYS = AGENT_RECORD_SPEC.map((s) => s.key as string);
const OPERATOR_KEYS = AGENT_RECORD_SPEC.filter((s) => s.writer === 'operator').map(
  (s) => s.key as string,
);
const ADMIN_KEYS = AGENT_RECORD_SPEC.filter((s) => s.writer === 'admin').map(
  (s) => s.key as string,
);
const ADMIN_RESOLVER_CONTROL = RESOLVER_ROLES.SET_TEXT | (RESOLVER_ROLES.SET_TEXT << 128n);

// ── configuration ────────────────────────────────────────────────────────
const env = loadEnv(['ens-admin', 'hedera-providers', 'x402'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia') {
  throw new ProvisionError('this script runs on Sepolia only (ENS_CHAIN=sepolia)');
}
const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
const admin = privateKeyToAccount(env.require('ENS_ADMIN_PRIVATE_KEY') as `0x${string}`);
const transport = http(env.require('ETH_RPC_URL'), { timeout: 30_000, retryCount: 1 });
const client = createPublicClient({ chain: sepolia, transport, batch: { multicall: true } });
const wallet = createWalletClient({ chain: sepolia, transport, account: admin });
const confirm = hasFlag('--confirm');

const accounts = parseLabelledAccounts(env.require('HEDERA_PROVIDER_ACCOUNTS'));
if (typeof accounts === 'string')
  throw new AgentManifestError(`HEDERA_PROVIDER_ACCOUNTS ${accounts}`);
const payToByLabel = new Map(accounts.map((a) => [a.label, a.accountId]));
const missing = missingPayoutLabels(payToByLabel);
if (missing.length > 0) {
  throw new AgentManifestError(
    `HEDERA_PROVIDER_ACCOUNTS has no payout account for: ${missing.join(', ')}. ` +
      'Run `pnpm hedera:create-providers -- --confirm` (existing labels are skipped) and add the printed label:0.0.N pairs.',
  );
}
const endpointBase = env.require('ENS_AGENT_ENDPOINT_BASE');
const inputs = {
  endpointBase,
  payToByLabel,
  network: env.require('X402_NETWORK') as X402Network,
  asset: env.require('X402_ASSET'),
  maxPriceAtomic: BigInt(env.require('X402_MAX_PAYMENT_TINYBARS')),
};
const agents = AGENTS.map((def) => {
  const name = `${def.label}.${parent.name}`;
  return { def, name, dns: dnsEncode(name), desired: desiredAgentText(def, inputs) };
});

const chainId = await client.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID)
  throw new ProvisionError(`ETH_RPC_URL is chain ${chainId}, not Sepolia`);

// ── operators: committed addresses must match the local key file ─────────
const previous: Deployment | null = existsSync(DEPLOYMENT_PATH)
  ? parseDeployment(readFileSync(DEPLOYMENT_PATH, 'utf8'))
  : null;
const keyFileExpect = { chainId, parent: parent.name, admin: admin.address };
let operatorFile: OperatorKeyFile | null = loadOperatorKeyFile(OPERATOR_KEY_PATH, keyFileExpect);
for (const a of previous?.agents ?? []) {
  const local = operatorFile?.operators[a.label]?.address;
  if (local === undefined || local.toLowerCase() !== a.operator.toLowerCase()) {
    throw new ProvisionError(
      `${DEPLOYMENT_PATH} lists operator ${a.operator} for "${a.label}" but ${OPERATOR_KEY_PATH} does not hold its key. ` +
        'Restore the key file; operators are never rotated silently (revocation is plan row 13).',
    );
  }
}
const operatorOf = (label: string): string | null =>
  operatorFile?.operators[label]?.address ?? null;

/** Generate missing operator keys and persist them BEFORE any role is granted. */
function ensureOperators(): void {
  const ops: Record<string, { address: string; privateKey: string }> = {
    ...(operatorFile?.operators ?? {}),
  };
  let created = 0;
  for (const { def } of agents) {
    if (ops[def.label] !== undefined) continue;
    const privateKey = generatePrivateKey();
    ops[def.label] = { address: privateKeyToAccount(privateKey).address, privateKey };
    created += 1;
  }
  if (created === 0) return;
  const file: OperatorKeyFile = { version: 1, ...keyFileExpect, operators: ops };
  saveOperatorKeyFile(OPERATOR_KEY_PATH, file);
  operatorFile = loadOperatorKeyFile(OPERATOR_KEY_PATH, keyFileExpect);
  console.log(
    `  generated ${created} operator key(s) → ${OPERATOR_KEY_PATH} (gitignored, never printed)\n`,
  );
}

// ── predicted addresses (same salts as ens:subname) ──────────────────────
const predict = (salt: bigint) =>
  client.readContract({
    address: R.verifiableFactory,
    abi: verifiableFactoryAbi,
    functionName: 'predictProxyAddress',
    args: [admin.address, salt],
  });
const registry = await predict(userRegistrySalt(parent.name));
const resolvers = new Map<string, Address>();
for (const a of agents) resolvers.set(a.def.label, await predict(agentResolverSalt(a.name)));

console.log(
  `ENSv2 agent provisioning on Sepolia ${confirm ? '(CONFIRM: sending transactions)' : '(dry run: read-only)'}`,
);
console.log(`  parent        ${parent.name}`);
console.log(`  admin         ${admin.address}`);
console.log(`  subregistry   ${registry} (predicted)`);
for (const a of agents)
  console.log(`  ${a.def.label.padEnd(13)} ${a.name} → resolver ${resolvers.get(a.def.label)}`);
console.log(
  `  endpoints     ${endpointBase}/v1/<label>${endpointBase.startsWith('http:') ? '  (LOCAL: re-provision with the https URL after deployment)' : ''}\n`,
);

// ── facts ────────────────────────────────────────────────────────────────
const hasCode = async (address: Address) => ((await client.getCode({ address })) ?? '0x') !== '0x';

async function readTexts(
  resolver: Address,
  name: string,
  dns: `0x${string}`,
): Promise<Record<string, string>> {
  const node = namehash(name);
  const calls = RECORD_KEYS.map((key) =>
    encodeFunctionData({ abi: textResolverAbi, functionName: 'text', args: [node, key] }),
  );
  const data = encodeFunctionData({
    abi: permissionedResolverAbi,
    functionName: 'multicall',
    args: [calls],
  });
  const raw = await client.readContract({
    address: resolver,
    abi: permissionedResolverAbi,
    functionName: 'resolve',
    args: [dns, data],
  });
  const [results] = decodeAbiParameters([{ type: 'bytes[]' }], raw);
  const out: Record<string, string> = {};
  RECORD_KEYS.forEach((key, i) => {
    const [value] = decodeAbiParameters([{ type: 'string' }], results[i] as `0x${string}`);
    out[key] = value;
  });
  return out;
}

async function agentFacts(
  a: (typeof agents)[number],
  registryDeployed: boolean,
): Promise<AgentFacts> {
  const resolver = resolvers.get(a.def.label) as Address;
  const operator = operatorOf(a.def.label);
  const resolverDeployed = await hasCode(resolver);
  const [subExpiry, resolverOnChain] = registryDeployed
    ? await Promise.all([
        client.readContract({
          address: registry,
          abi: permissionedRegistryAbi,
          functionName: 'getExpiry',
          args: [labelId(a.def.label)],
        }),
        client.readContract({
          address: registry,
          abi: permissionedRegistryAbi,
          functionName: 'getResolver',
          args: [a.def.label],
        }),
      ])
    : [0n, ZERO_ADDRESS as string];
  let adminControlsResolver = false;
  let currentText: Record<string, string> = {};
  const operatorRoles: Record<string, bigint> = {};
  let operatorRootRoles = 0n;
  if (resolverDeployed) {
    const roleOf = (resource: bigint, account: string) =>
      client.readContract({
        address: resolver,
        abi: permissionedResolverAbi,
        functionName: 'roles',
        args: [resource, account as Address],
      });
    [adminControlsResolver, currentText] = await Promise.all([
      client.readContract({
        address: resolver,
        abi: permissionedResolverAbi,
        functionName: 'hasRootRoles',
        args: [ADMIN_RESOLVER_CONTROL, admin.address],
      }),
      readTexts(resolver, a.name, a.dns),
    ]);
    if (operator !== null) {
      const [root, ...perKey] = await Promise.all([
        roleOf(0n, operator),
        ...RECORD_KEYS.map((k) => roleOf(textKeyResource(k), operator)),
      ]);
      operatorRootRoles = root as bigint;
      RECORD_KEYS.forEach((k, i) => (operatorRoles[k] = perKey[i] as bigint));
    }
  }
  return {
    label: a.def.label,
    resolver,
    resolverDeployed,
    adminControlsResolver,
    subExpiry,
    resolverOnChain,
    currentText,
    desiredText: a.desired,
    operator,
    operatorRoles,
    operatorRootRoles,
  };
}

async function gatherFacts(): Promise<ProvisionFacts> {
  const [ethBalance, block, parentExpiry, parentSubregistry, registryDeployed] = await Promise.all([
    client.getBalance({ address: admin.address }),
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
    hasCode(registry),
  ]);
  let adminControlsRegistry = false;
  let registryParent: ProvisionFacts['registryParent'] = null;
  if (registryDeployed) {
    const [control, [p, l]] = await Promise.all([
      client.readContract({
        address: registry,
        abi: permissionedRegistryAbi,
        functionName: 'hasRootRoles',
        args: [REGISTRY_ROLES.REGISTRAR, admin.address],
      }),
      client.readContract({
        address: registry,
        abi: permissionedRegistryAbi,
        functionName: 'getParent',
      }),
    ]);
    adminControlsRegistry = control;
    registryParent = { parent: p, label: l };
  }
  const agentList: AgentFacts[] = [];
  for (const a of agents) agentList.push(await agentFacts(a, registryDeployed));
  return {
    ethBalance,
    minEth: MIN_ETH,
    now: block.timestamp,
    parentLabel: parent.label,
    ethRegistry: R.ethRegistry,
    parentExpiry,
    parentSubregistry,
    registry,
    registryDeployed,
    adminControlsRegistry,
    registryParent,
    recordKeys: RECORD_KEYS,
    operatorKeys: OPERATOR_KEYS,
    operatorRole: RESOLVER_ROLES.SET_TEXT,
    agents: agentList,
  };
}

// ── execution ────────────────────────────────────────────────────────────
const startedAt = new Date().toISOString();
const txLog: { step: string; agent: string | null; hash: Hash; url: string }[] = [];

async function send(step: ProvisionStep, request: Parameters<typeof wallet.writeContract>[0]) {
  const hash = await wallet.writeContract(request);
  txLog.push({ step: step.kind, agent: step.agent ?? null, hash, url: sepoliaEtherscanTx(hash) });
  console.log(`  sent ${hash}  ${sepoliaEtherscanTx(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success')
    throw new ProvisionError(`${step.kind} transaction ${hash} reverted`);
  console.log(`  confirmed in block ${receipt.blockNumber}`);
  return receipt;
}

async function deployProxy(
  step: ProvisionStep,
  implementation: Address,
  salt: bigint,
  data: `0x${string}`,
  expected: Address,
) {
  const { request, result: predicted } = await client.simulateContract({
    account: admin,
    address: R.verifiableFactory,
    abi: verifiableFactoryAbi,
    functionName: 'deployProxy',
    args: [implementation, salt, data],
  });
  if (predicted.toLowerCase() !== expected.toLowerCase()) {
    throw new ProvisionError(
      `${step.kind}: simulated proxy ${predicted} differs from the predicted ${expected}`,
    );
  }
  const receipt = await send(step, request);
  const log = parseEventLogs({
    abi: verifiableFactoryAbi,
    eventName: 'ProxyDeployed',
    logs: receipt.logs,
  })[0];
  if (log !== undefined && log.args.proxyAddress.toLowerCase() !== expected.toLowerCase()) {
    throw new ProvisionError(`${step.kind}: deployed proxy differs from the predicted address`);
  }
  console.log(`  proxy ${expected}  ${sepoliaEtherscanAddress(expected)}`);
}

async function call(
  step: ProvisionStep,
  address: Address,
  abi: typeof permissionedResolverAbi | typeof permissionedRegistryAbi,
  functionName: string,
  args: readonly unknown[],
) {
  const { request } = await client.simulateContract({
    account: admin,
    address,
    abi,
    functionName,
    args,
  } as unknown as Parameters<typeof client.simulateContract>[0]);
  await send(step, request as unknown as Parameters<typeof wallet.writeContract>[0]);
}

async function execute(step: ProvisionStep, facts: ProvisionFacts): Promise<void> {
  const a = agents.find((x) => x.def.label === step.agent);
  const resolver = a === undefined ? null : (resolvers.get(a.def.label) as Address);
  switch (step.kind) {
    case 'DEPLOY_REGISTRY':
      return deployProxy(
        step,
        R.userRegistryImpl,
        userRegistrySalt(parent.name),
        encodeFunctionData({
          abi: permissionedRegistryAbi,
          functionName: 'initialize',
          args: [[{ account: admin.address, roleBitmap: USER_REGISTRY_ROOT_ROLES }]],
        }),
        registry,
      );
    case 'SET_SUBREGISTRY':
      return call(step, R.ethRegistry, permissionedRegistryAbi, 'setSubregistry', [
        labelId(parent.label),
        registry,
      ]);
    case 'SET_PARENT':
      return call(step, registry, permissionedRegistryAbi, 'setParent', [
        R.ethRegistry,
        parent.label,
      ]);
    case 'DEPLOY_RESOLVER':
      if (a === undefined || resolver === null) break;
      return deployProxy(
        step,
        R.permissionedResolverImpl,
        agentResolverSalt(a.name),
        encodeFunctionData({
          abi: permissionedResolverAbi,
          functionName: 'initialize',
          args: [[{ account: admin.address, roleBitmap: ALL_RESOLVER_ROLES }], []],
        }),
        resolver,
      );
    case 'REGISTER_SUBNAME':
      if (a === undefined || resolver === null) break;
      return call(step, registry, permissionedRegistryAbi, 'register', [
        a.def.label,
        admin.address,
        ZERO_ADDRESS,
        resolver,
        SUBNAME_TOKEN_ROLES,
        facts.parentExpiry,
      ]);
    case 'SET_RESOLVER':
      if (a === undefined || resolver === null) break;
      return call(step, registry, permissionedRegistryAbi, 'setResolver', [
        labelId(a.def.label),
        resolver,
      ]);
    case 'SET_RECORDS': {
      if (a === undefined || resolver === null) break;
      const calls = (step.keys ?? []).map((key) =>
        encodeFunctionData({
          abi: permissionedResolverAbi,
          functionName: 'setText',
          args: [a.dns, key, (a.desired as Record<string, string>)[key] ?? ''],
        }),
      );
      return call(step, resolver, permissionedResolverAbi, 'multicall', [calls]);
    }
    case 'REVOKE_ROLES':
    case 'GRANT_ROLES': {
      if (a === undefined || resolver === null) break;
      const operator = operatorOf(a.def.label);
      if (operator === null) throw new ProvisionError(`no operator for "${a.def.label}"`);
      const calls = (step.changes ?? []).map((c) => {
        if (step.kind === 'GRANT_ROLES') {
          const setter = encodeFunctionData({
            abi: permissionedResolverAbi,
            functionName: 'setText',
            args: [a.dns, c.key ?? '', ''],
          });
          return encodeFunctionData({
            abi: permissionedResolverAbi,
            functionName: 'grantSetterRoles',
            args: [setter, operator as Address],
          });
        }
        return c.key === null
          ? encodeFunctionData({
              abi: permissionedResolverAbi,
              functionName: 'revokeRootRoles',
              args: [c.bits, operator as Address],
            })
          : encodeFunctionData({
              abi: permissionedResolverAbi,
              functionName: 'revokeRoles',
              args: [textKeyResource(c.key), c.bits, operator as Address],
            });
      });
      return call(step, resolver, permissionedResolverAbi, 'multicall', [calls]);
    }
    default:
      return;
  }
  throw new ProvisionError(`step ${step.kind} names an unknown agent`);
}

const describe = (s: ProvisionStep): string => {
  const detail =
    s.keys !== undefined
      ? ` [${s.keys.join(', ')}]`
      : s.changes !== undefined
        ? ` [${s.changes.map((c) => c.key ?? 'ROOT').join(', ')}]`
        : '';
  return `${s.kind}${s.agent === undefined ? '' : ` (${s.agent})`}${detail} — ${s.reason}`;
};

let facts = await gatherFacts();
console.log('preflight');
console.log(
  `  ETH balance          ${formatEther(facts.ethBalance)} (need ≥ ${formatEther(MIN_ETH)} to send)`,
);
console.log(`  parent subregistry   ${facts.parentSubregistry}`);
for (const a of facts.agents) {
  const differing = a.resolverDeployed
    ? RECORD_KEYS.filter((k) => (a.currentText[k] ?? '') !== (a.desiredText[k] ?? '')).length
    : RECORD_KEYS.length;
  console.log(
    `  ${a.label.padEnd(20)} resolver ${a.resolverDeployed ? 'deployed' : 'missing '} · ${a.subExpiry > facts.now ? 'registered' : 'unregistered'} · ${differing} record(s) to write · operator ${a.operator ?? '(generated on --confirm)'}`,
  );
}
console.log('');

let step = nextProvisionStep(facts);
if (confirm && !isProvisionTerminal(step.kind)) ensureOperators();
if (confirm) {
  facts = await gatherFacts();
  step = nextProvisionStep(facts);
}
let guard = 0;
const planned: string[] = [];
while (!isProvisionTerminal(step.kind)) {
  console.log(`next: ${describe(step)}`);
  if (!confirm) {
    planned.push(describe(step));
    console.log(
      '\nDRY RUN: nothing sent. The first pending step is shown; re-run with --confirm to execute all steps.',
    );
    break;
  }
  if (++guard > 40)
    throw new ProvisionError('too many steps; stopping (re-run to resume from chain state)');
  await execute(step, facts);
  facts = await gatherFacts();
  step = nextProvisionStep(facts);
}
console.log(`\n${step.kind}: ${step.reason}`);

// ── independent verification through the Universal Resolver ──────────────
interface AgentCheck {
  label: string;
  name: string;
  resolver: string;
  universalResolverResolver: string | null;
  records: Record<string, string | null>;
  recordsMatch: boolean;
  schemaValid: boolean;
  operator: string | null;
  operatorKeysGranted: boolean;
  adminKeysDeniedToOperator: boolean;
  operatorHasNoRootRoles: boolean;
  verified: boolean;
}
const checks: AgentCheck[] = [];
if (step.kind === 'DONE') {
  console.log('\nverification (Universal Resolver + role reads)');
  for (const a of agents) {
    const f = facts.agents.find((x) => x.label === a.def.label) as AgentFacts;
    const universalResolverResolver = await client
      .getEnsResolver({ name: a.name, universalResolverAddress: R.universalResolver })
      .catch(() => null);
    const records: Record<string, string | null> = {};
    for (const key of RECORD_KEYS) {
      records[key] = await client
        .getEnsText({ name: a.name, key, universalResolverAddress: R.universalResolver })
        .catch(() => null);
    }
    const desired = a.desired as Record<string, string>;
    const recordsMatch = RECORD_KEYS.every((k) => (records[k] ?? '') === (desired[k] ?? ''));
    const schemaValid = parseAgentRecords(records, {
      allowLocalHttp: true,
      expectedNetwork: inputs.network,
    }).ok;
    const operatorKeysGranted = OPERATOR_KEYS.every(
      (k) => ((f.operatorRoles[k] ?? 0n) & RESOLVER_ROLES.SET_TEXT) !== 0n,
    );
    const adminKeysDeniedToOperator = ADMIN_KEYS.every((k) => (f.operatorRoles[k] ?? 0n) === 0n);
    const operatorHasNoRootRoles = f.operatorRootRoles === 0n;
    const verified =
      universalResolverResolver !== null &&
      universalResolverResolver.toLowerCase() === f.resolver.toLowerCase() &&
      recordsMatch &&
      schemaValid &&
      f.operator !== null &&
      operatorKeysGranted &&
      adminKeysDeniedToOperator &&
      operatorHasNoRootRoles;
    checks.push({
      label: a.def.label,
      name: a.name,
      resolver: f.resolver,
      universalResolverResolver,
      records,
      recordsMatch,
      schemaValid,
      operator: f.operator,
      operatorKeysGranted,
      adminKeysDeniedToOperator,
      operatorHasNoRootRoles,
      verified,
    });
    console.log(
      `  ${a.name.padEnd(28)} ${verified ? 'OK  ' : 'FAIL'} resolver ${universalResolverResolver === null ? 'unresolved' : 'via UR'} · records ${recordsMatch ? 'match' : 'DIFFER'} · schema ${schemaValid ? 'valid' : 'INVALID'} · operator ${operatorKeysGranted ? `SET_TEXT on ${OPERATOR_KEYS.length} keys` : 'MISSING ROLES'}, ${adminKeysDeniedToOperator && operatorHasNoRootRoles ? 'no payout/root roles' : 'EXCESS ROLES'}`,
    );
  }
}
const allVerified =
  step.kind === 'DONE' && checks.length === agents.length && checks.every((c) => c.verified);

// ── deployments/sepolia.json (only from verified state) ──────────────────
let deploymentStatus: 'written' | 'unchanged' | 'not-written' = 'not-written';
if (allVerified) {
  const deployment: Deployment = {
    kind: 'ens-deployment',
    version: 1,
    chain: 'sepolia',
    chainId,
    parent: parent.name,
    admin: admin.address,
    contracts: {
      ethRegistry: R.ethRegistry,
      universalResolver: R.universalResolver,
      verifiableFactory: R.verifiableFactory,
      userRegistryImpl: R.userRegistryImpl,
      permissionedResolverImpl: R.permissionedResolverImpl,
    },
    subregistry: registry,
    agents: agents.map((a) => {
      const f = facts.agents.find((x) => x.label === a.def.label) as AgentFacts;
      return {
        label: a.def.label,
        name: a.name,
        resolver: f.resolver,
        expiry: f.subExpiry.toString(),
        operator: f.operator as string,
        operatorKeys: OPERATOR_KEYS,
        adminKeys: ADMIN_KEYS,
        records: publishedRecords(RECORD_KEYS, f.currentText),
      };
    }),
  };
  if (previous !== null && sameDeployment(previous, deployment)) {
    deploymentStatus = 'unchanged';
    console.log(`\n${DEPLOYMENT_PATH} unchanged`);
  } else if (confirm) {
    mkdirSync(dirname(DEPLOYMENT_PATH), { recursive: true });
    writeFileSync(DEPLOYMENT_PATH, serializeDeployment(deployment), 'utf8');
    deploymentStatus = 'written';
    console.log(`\n${DEPLOYMENT_PATH} written`);
  } else {
    console.log(`\n${DEPLOYMENT_PATH} is out of date (dry run: re-run with --confirm to write it)`);
  }
}

if (hasFlag('--save-evidence')) {
  const path = writeEvidence('ens', allVerified ? 'provision' : 'provision-attempt', {
    kind: 'ens-provision',
    startedAt,
    finishedAt: new Date().toISOString(),
    chain: 'sepolia',
    chainId,
    parent: parent.name,
    admin: admin.address,
    subregistry: registry,
    endpointBase,
    confirm,
    finalStep: step,
    plannedNext: planned,
    sentThisRun: txLog,
    noOp: confirm && txLog.length === 0,
    deploymentFile: { path: DEPLOYMENT_PATH, status: deploymentStatus },
    agents: checks,
    verified: allVerified,
  });
  console.log(`Evidence written to ${path}`);
}

if (allVerified) {
  console.log(
    txLog.length === 0
      ? `\nRERUN NO-OP: all ${agents.length} agents already provisioned; 0 transactions sent; ${DEPLOYMENT_PATH} ${deploymentStatus}.`
      : `\nPROVISIONED: ${agents.length} agents resolve through the Universal Resolver with their own resolvers, valid records and scoped operator roles (${txLog.length} transactions).`,
  );
} else if (confirm || isProvisionTerminal(step.kind)) {
  // A dry run with pending steps is a successful preview; anything else that is not verified fails.
  process.exitCode = 1;
}
