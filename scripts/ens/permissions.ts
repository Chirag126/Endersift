/**
 * Prove on Sepolia that ENSv2 permissions are enforced per agent (plan row 13):
 *   A edits A ✓ · A edits B ✗ · A edits x402.payTo ✗ · admin revokes A ✓
 *   (then A edits A ✗, and the admin re-grants, leaving the deployment as provisioned).
 *
 *   pnpm ens:permissions                         dry run: role matrix + simulations, sends nothing
 *   pnpm ens:permissions -- --confirm --save-evidence
 *   pnpm ens:permissions -- --a kev --b cve     choose the agents (defaults shown)
 *
 * Every case is simulated first. Denied cases are sent only after the
 * simulation reverted with EACUnauthorizedAccountRoles for exactly that key,
 * role and operator, so the on-chain revert becomes evidence but a permission
 * hole is never exercised. Denied cases write the record's current value.
 *
 * Preconditions are the provisioned state (deployments/sepolia.json, exact
 * operator roles, original records). If a previous run was interrupted, run
 * `pnpm ens:provision -- --confirm` first; it restores both.
 */
import { readFileSync } from 'node:fs';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  AGENT_RECORD_SPEC,
  PERMISSION_CASES,
  NEEDS_PRIOR_TX,
  RESOLVER_ROLES,
  SEPOLIA_CHAIN_ID,
  caseVerdict,
  decideSend,
  dnsEncode,
  loadOperatorKeyFile,
  parseDeployment,
  parseParentLabel,
  permissionedResolverAbi,
  roleScopeProblems,
  sepoliaEtherscanTx,
  testDescription,
  textKeyResource,
  textResolverAbi,
  type CaseId,
  type CaseSpec,
  type ExpectedDenial,
  type OperatorRoles,
  type Simulation,
  type Verdict,
} from '../../packages/ens/src/index.ts';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeFunctionData,
  formatEther,
  http,
  namehash,
  parseEther,
  privateKeyToAccount,
  sepolia,
  type Address,
  type Hash,
} from '../../packages/ens/src/viem.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  fileStamp,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

class PermissionTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionTestError';
  }
}

const DEPLOYMENT_PATH = 'deployments/sepolia.json';
const OPERATOR_KEY_PATH = '.secrets/ens-operator-keys.json';
const OPERATOR_MIN_ETH = parseEther('0.002');
const OPERATOR_TOP_UP = parseEther('0.004');
/** Fixed gas for denied cases, so the transaction is mined (and reverts) instead of failing estimation. */
const DENIED_TX_GAS = 150_000n;
const SET_TEXT = RESOLVER_ROLES.SET_TEXT;
const RECORD_KEYS = AGENT_RECORD_SPEC.map((s) => s.key as string);
const OPERATOR_KEYS = AGENT_RECORD_SPEC.filter((s) => s.writer === 'operator').map(
  (s) => s.key as string,
);
const EDIT_KEY = 'description';
const PAYOUT_KEY = 'x402.payTo';

// ── configuration ────────────────────────────────────────────────────────
const env = loadEnv(['ens-admin'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia') {
  throw new PermissionTestError('this script runs on Sepolia only (ENS_CHAIN=sepolia)');
}
const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
const admin = privateKeyToAccount(env.require('ENS_ADMIN_PRIVATE_KEY') as `0x${string}`);
const transport = http(env.require('ETH_RPC_URL'), { timeout: 30_000, retryCount: 1 });
const client = createPublicClient({ chain: sepolia, transport, batch: { multicall: true } });
const confirm = hasFlag('--confirm');
const labelA = argValue('--a') ?? 'kev';
const labelB = argValue('--b') ?? 'cve';
if (labelA === labelB) throw new PermissionTestError('--a and --b must be different agents');

const chainId = await client.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID)
  throw new PermissionTestError(`ETH_RPC_URL is chain ${chainId}, not Sepolia`);

const deployment = parseDeployment(readFileSync(DEPLOYMENT_PATH, 'utf8'));
if (
  deployment.parent !== parent.name ||
  deployment.admin.toLowerCase() !== admin.address.toLowerCase()
) {
  throw new PermissionTestError(
    `${DEPLOYMENT_PATH} is for another parent or admin; run pnpm ens:provision first`,
  );
}
const agentByLabel = (label: string) => {
  const a = deployment.agents.find((x) => x.label === label);
  if (a === undefined)
    throw new PermissionTestError(`agent "${label}" is not in ${DEPLOYMENT_PATH}`);
  return { ...a, dns: dnsEncode(a.name), resolver: a.resolver as Address };
};
const A = agentByLabel(labelA);
const B = agentByLabel(labelB);

const keyFile = loadOperatorKeyFile(OPERATOR_KEY_PATH, {
  chainId,
  parent: parent.name,
  admin: admin.address,
});
const opKey = keyFile?.operators[labelA];
if (opKey === undefined || opKey.address.toLowerCase() !== A.operator.toLowerCase()) {
  throw new PermissionTestError(
    `${OPERATOR_KEY_PATH} does not hold the key of ${labelA}'s operator ${A.operator}; restore it from your backup`,
  );
}
const operatorA = privateKeyToAccount(opKey.privateKey as `0x${string}`);
const adminWallet = createWalletClient({ chain: sepolia, transport, account: admin });
const operatorWallet = createWalletClient({ chain: sepolia, transport, account: operatorA });

console.log(
  `ENSv2 permission enforcement on Sepolia ${confirm ? '(CONFIRM: sending transactions)' : '(dry run: simulations only)'}`,
);
console.log(`  agent A      ${A.name}  resolver ${A.resolver}`);
console.log(`  operator A   ${operatorA.address}`);
console.log(`  agent B      ${B.name}  resolver ${B.resolver}`);
console.log(`  admin        ${admin.address}\n`);

// ── reads ────────────────────────────────────────────────────────────────
async function readText(
  resolver: Address,
  name: string,
  dns: `0x${string}`,
  key: string,
): Promise<string> {
  const raw = await client.readContract({
    address: resolver,
    abi: permissionedResolverAbi,
    functionName: 'resolve',
    args: [
      dns,
      encodeFunctionData({
        abi: textResolverAbi,
        functionName: 'text',
        args: [namehash(name), key],
      }),
    ],
  });
  return decodeAbiParameters([{ type: 'string' }], raw)[0];
}

/** roles of `account` on every agent resolver: per record key, plus ROOT. */
async function rolesOf(account: string): Promise<OperatorRoles> {
  const out: Record<string, Record<string, bigint>> = {};
  for (const agent of deployment.agents) {
    const resolver = agent.resolver as Address;
    const read = (resource: bigint) =>
      client.readContract({
        address: resolver,
        abi: permissionedResolverAbi,
        functionName: 'roles',
        args: [resource, account as Address],
      });
    const [root, ...perKey] = await Promise.all([
      read(0n),
      ...RECORD_KEYS.map((k) => read(textKeyResource(k))),
    ]);
    const row: Record<string, bigint> = { ROOT: root as bigint };
    RECORD_KEYS.forEach((k, i) => (row[k] = perKey[i] as bigint));
    out[agent.label] = row;
  }
  return out;
}

async function roleMatrix(): Promise<
  Record<string, { operator: string; roles: OperatorRoles; problems: string[] }>
> {
  const out: Record<string, { operator: string; roles: OperatorRoles; problems: string[] }> = {};
  for (const agent of deployment.agents) {
    const roles = await rolesOf(agent.operator);
    out[agent.label] = {
      operator: agent.operator,
      roles,
      problems: roleScopeProblems({
        ownLabel: agent.label,
        roles,
        recordKeys: RECORD_KEYS,
        operatorKeys: OPERATOR_KEYS,
        role: SET_TEXT,
      }),
    };
  }
  return out;
}

const printMatrix = (title: string, m: Awaited<ReturnType<typeof roleMatrix>>) => {
  console.log(title);
  for (const [label, entry] of Object.entries(m)) {
    const own = entry.roles[label] ?? {};
    const granted = OPERATOR_KEYS.filter((k) => ((own[k] ?? 0n) & SET_TEXT) !== 0n).length;
    console.log(
      `  operator ${label.padEnd(4)} ${entry.operator}  SET_TEXT on ${granted}/${OPERATOR_KEYS.length} keys of its own resolver · ${entry.problems.length === 0 ? 'nothing else anywhere' : `PROBLEMS: ${entry.problems.join('; ')}`}`,
    );
  }
};

// ── preconditions: the provisioned state ─────────────────────────────────
const originalA = await readText(A.resolver, A.name, A.dns, EDIT_KEY);
const originalB = await readText(B.resolver, B.name, B.dns, EDIT_KEY);
const payToA = await readText(A.resolver, A.name, A.dns, PAYOUT_KEY);
const before = await roleMatrix();
printMatrix('role matrix (before)', before);
const preProblems = [
  ...Object.values(before).flatMap((e) => e.problems),
  ...(originalA === A.records[EDIT_KEY]
    ? []
    : [`${A.name} ${EDIT_KEY} differs from ${DEPLOYMENT_PATH}`]),
  ...(payToA === A.records[PAYOUT_KEY]
    ? []
    : [`${A.name} ${PAYOUT_KEY} differs from ${DEPLOYMENT_PATH}`]),
];
if (preProblems.length > 0) {
  throw new PermissionTestError(
    `the deployment is not in its provisioned state (${preProblems.join('; ')}). Run \`pnpm ens:provision -- --confirm\` first.`,
  );
}
console.log(`  records      ${A.name} ${EDIT_KEY} and ${PAYOUT_KEY} match ${DEPLOYMENT_PATH}\n`);

// ── funding operator A (it pays for its own allowed and denied transactions) ─
const startedAt = new Date().toISOString();
const stamp = fileStamp();
let fundingTx: { hash: Hash; url: string; amountWei: bigint } | null = null;
const opBalance = await client.getBalance({ address: operatorA.address });
console.log(
  `operator A balance ${formatEther(opBalance)} ETH (needs ≥ ${formatEther(OPERATOR_MIN_ETH)} with --confirm)`,
);
if (confirm && opBalance < OPERATOR_MIN_ETH) {
  const hash = await adminWallet.sendTransaction({ to: operatorA.address, value: OPERATOR_TOP_UP });
  console.log(
    `  admin funds operator A with ${formatEther(OPERATOR_TOP_UP)} ETH: ${sepoliaEtherscanTx(hash)}`,
  );
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success')
    throw new PermissionTestError(`funding transaction ${hash} failed`);
  fundingTx = { hash, url: sepoliaEtherscanTx(hash), amountWei: OPERATOR_TOP_UP };
}
console.log('');

// ── cases ────────────────────────────────────────────────────────────────
interface Call {
  address: Address;
  functionName: 'setText' | 'multicall';
  args: readonly unknown[];
}
const setText = (agent: typeof A, key: string, value: string): Call => ({
  address: agent.resolver,
  functionName: 'setText',
  args: [agent.dns, key, value],
});
const adminMulticall = (calls: `0x${string}`[]): Call => ({
  address: A.resolver,
  functionName: 'multicall',
  args: [calls],
});
const revokeCalls = () =>
  OPERATOR_KEYS.map((k) =>
    encodeFunctionData({
      abi: permissionedResolverAbi,
      functionName: 'revokeRoles',
      args: [textKeyResource(k), SET_TEXT, operatorA.address],
    }),
  );
const grantCalls = () =>
  OPERATOR_KEYS.map((k) =>
    encodeFunctionData({
      abi: permissionedResolverAbi,
      functionName: 'grantSetterRoles',
      args: [
        encodeFunctionData({
          abi: permissionedResolverAbi,
          functionName: 'setText',
          args: [A.dns, k, ''],
        }),
        operatorA.address,
      ],
    }),
  );
const denial = (key: string): ExpectedDenial => ({
  resource: textKeyResource(key),
  roleBitmap: SET_TEXT,
  account: operatorA.address,
});
const editValue = testDescription(originalA, stamp);

interface Plan {
  call: Call;
  expected: ExpectedDenial | null;
  /** Read-back after an allowed transaction. */
  verify?: () => Promise<boolean>;
}
const plans: Record<CaseId, Plan> = {
  A_EDITS_A: {
    call: setText(A, EDIT_KEY, editValue),
    expected: null,
    verify: async () => (await readText(A.resolver, A.name, A.dns, EDIT_KEY)) === editValue,
  },
  A_RESTORES_A: {
    call: setText(A, EDIT_KEY, originalA),
    expected: null,
    verify: async () => (await readText(A.resolver, A.name, A.dns, EDIT_KEY)) === originalA,
  },
  A_EDITS_B: { call: setText(B, EDIT_KEY, originalB), expected: denial(EDIT_KEY) },
  A_EDITS_PAYTO: { call: setText(A, PAYOUT_KEY, payToA), expected: denial(PAYOUT_KEY) },
  ADMIN_REVOKES_A: {
    call: adminMulticall(revokeCalls()),
    expected: null,
    verify: async () => {
      const row = (await rolesOf(operatorA.address))[A.label] ?? {};
      return RECORD_KEYS.every((k) => (row[k] ?? 0n) === 0n) && (row['ROOT'] ?? 0n) === 0n;
    },
  },
  A_EDITS_A_AFTER_REVOKE: { call: setText(A, EDIT_KEY, originalA), expected: denial(EDIT_KEY) },
  ADMIN_RESTORES_A: {
    call: adminMulticall(grantCalls()),
    expected: null,
    verify: async () => {
      const row = (await rolesOf(operatorA.address))[A.label] ?? {};
      return OPERATOR_KEYS.every((k) => (row[k] ?? 0n) === SET_TEXT);
    },
  },
};

async function simulate(spec: CaseSpec, call: Call): Promise<Simulation> {
  try {
    await client.simulateContract({
      account: spec.actor === 'admin' ? admin : operatorA,
      address: call.address,
      abi: permissionedResolverAbi,
      functionName: call.functionName,
      args: call.args,
    } as unknown as Parameters<typeof client.simulateContract>[0]);
    return { ok: true };
  } catch (error) {
    if (error instanceof BaseError) {
      const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
      if (reverted instanceof ContractFunctionRevertedError) {
        return {
          ok: false,
          errorName: reverted.data?.errorName ?? null,
          args: (reverted.data?.args as readonly unknown[] | undefined) ?? null,
        };
      }
    }
    throw error; // network or RPC failure: not a permission result
  }
}

async function sendCase(
  spec: CaseSpec,
  call: Call,
): Promise<{ hash: Hash; status: 'success' | 'reverted'; block: bigint }> {
  const wallet = spec.actor === 'admin' ? adminWallet : operatorWallet;
  const hash = await wallet.writeContract({
    address: call.address,
    abi: permissionedResolverAbi,
    functionName: call.functionName,
    args: call.args,
    ...(spec.expect === 'deny' ? { gas: DENIED_TX_GAS } : {}),
  } as unknown as Parameters<typeof wallet.writeContract>[0]);
  console.log(`    sent ${hash}  ${sepoliaEtherscanTx(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  console.log(
    `    ${receipt.status === 'success' ? 'succeeded' : 'REVERTED'} in block ${receipt.blockNumber}`,
  );
  return { hash, status: receipt.status, block: receipt.blockNumber };
}

interface CaseRecord {
  id: CaseId;
  title: string;
  actor: string;
  expect: 'allow' | 'deny';
  target: { resolver: string; name: string; function: string; key: string | null };
  simulation: Simulation | null;
  expectedDenial: ExpectedDenial | null;
  tx: { hash: Hash; url: string; status: 'success' | 'reverted'; block: bigint } | null;
  effectVerified: boolean | null;
  skipped: string | null;
  verdict: Verdict;
}
const records: CaseRecord[] = [];
let stop = false;

for (const spec of PERMISSION_CASES) {
  const plan = plans[spec.id];
  const agent = plan.call.address.toLowerCase() === B.resolver.toLowerCase() ? B : A;
  const key = plan.call.functionName === 'setText' ? (plan.call.args[1] as string) : null;
  const base = {
    id: spec.id,
    title: spec.title,
    actor: spec.actor === 'admin' ? admin.address : operatorA.address,
    expect: spec.expect,
    target: {
      resolver: plan.call.address,
      name: agent.name,
      function: plan.call.functionName,
      key,
    },
    expectedDenial: plan.expected,
  };
  console.log(`${spec.expect === 'allow' ? '✓' : '✗'} expected · ${spec.id}: ${spec.title}`);
  if (stop || (!confirm && NEEDS_PRIOR_TX.includes(spec.id))) {
    const why = stop
      ? 'an earlier case failed; stopped'
      : 'depends on an earlier transaction (runs with --confirm)';
    console.log(`    skipped: ${why}`);
    records.push({
      ...base,
      simulation: null,
      tx: null,
      effectVerified: null,
      skipped: why,
      verdict: { pass: false, reason: why },
    });
    continue;
  }
  const simulation = await simulate(spec, plan.call);
  console.log(
    `    simulation: ${simulation.ok ? 'succeeds' : `reverts with ${simulation.errorName ?? 'an undecoded error'}`}`,
  );
  let tx: CaseRecord['tx'] = null;
  let effectVerified: boolean | null = null;
  let skipped: string | null = null;
  if (confirm) {
    const decision = decideSend(spec.expect, simulation, plan.expected);
    if (decision.send) {
      const sent = await sendCase(spec, plan.call);
      tx = { ...sent, url: sepoliaEtherscanTx(sent.hash) };
      if (spec.expect === 'allow' && sent.status === 'success' && plan.verify !== undefined) {
        effectVerified = await plan.verify();
      }
    } else {
      skipped = decision.reason;
      console.log(`    not sent: ${decision.reason}`);
    }
  }
  const verdict = caseVerdict(
    {
      expect: spec.expect,
      simulation,
      expected: plan.expected,
      txStatus: tx?.status ?? null,
      effectVerified,
    },
    confirm,
  );
  console.log(`    ${verdict.pass ? 'PASS' : 'FAIL'}: ${verdict.reason}\n`);
  records.push({ ...base, simulation, tx, effectVerified, skipped, verdict });
  if (confirm && !verdict.pass) stop = true; // never continue from an unknown state
}

// ── final state ──────────────────────────────────────────────────────────
const after = await roleMatrix();
printMatrix('\nrole matrix (after)', after);
const finalDescription = await readText(A.resolver, A.name, A.dns, EDIT_KEY);
const finalPayTo = await readText(A.resolver, A.name, A.dns, PAYOUT_KEY);
const restored =
  Object.values(after).every((e) => e.problems.length === 0) &&
  finalDescription === originalA &&
  finalPayTo === payToA;
console.log(
  `  restored     ${restored ? 'yes: roles and records are exactly as provisioned' : 'NO: run pnpm ens:provision -- --confirm'}`,
);

const ran = records.filter((r) => r.skipped === null || r.tx !== null);
const allPass = records.every((r) => r.verdict.pass);
const verified = confirm && allPass && restored;

if (hasFlag('--save-evidence')) {
  const path = writeEvidence(
    'ens',
    verified ? 'permissions' : confirm ? 'permissions-attempt' : 'permissions-dry-run',
    {
      kind: 'ens-permissions',
      startedAt,
      finishedAt: new Date().toISOString(),
      chain: 'sepolia',
      chainId,
      parent: parent.name,
      admin: admin.address,
      agentA: { label: A.label, name: A.name, resolver: A.resolver, operator: operatorA.address },
      agentB: { label: B.label, name: B.name, resolver: B.resolver, operator: B.operator },
      confirm,
      funding: fundingTx,
      roleMatrixBefore: before,
      cases: records,
      roleMatrixAfter: after,
      restored,
      verified,
    },
  );
  console.log(`\nEvidence written to ${path}`);
}

if (verified) {
  console.log(
    `\nPERMISSIONS ENFORCED: ${records.length}/${records.length} cases passed on chain (A edits A ✓, A edits B ✗, A edits ${PAYOUT_KEY} ✗, admin revokes A ✓ then A ✗, re-grant ✓); deployment restored.`,
  );
} else if (!confirm) {
  const simulated = ran.length;
  console.log(
    `\nDRY RUN: ${records.filter((r) => r.verdict.pass).length}/${simulated} simulated cases behave as expected; ${records.length - simulated} need --confirm.`,
  );
  if (records.some((r) => r.skipped === null && !r.verdict.pass)) process.exitCode = 1;
} else {
  process.exitCode = 1;
}
