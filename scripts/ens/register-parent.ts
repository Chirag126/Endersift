/**
 * Register ENS_PARENT_NAME on the ENSv2 Sepolia deployment, give it a resolver
 * of our own, set text records, and read them back through the Universal
 * Resolver with viem's getEnsText.
 *
 *   pnpm ens:register                      dry run: read-only preflight + the next step
 *   pnpm ens:register -- --confirm         execute every step until done (sends Sepolia txs)
 *   pnpm ens:register -- --confirm --save-evidence
 *   pnpm ens:register -- --resolver 0x...  reuse a resolver you already deployed
 *
 * Steps (decided by packages/ens/src/plan.ts from live chain facts):
 *   DEPLOY_RESOLVER  PermissionedResolver proxy via the VerifiableFactory, all roles to you
 *   COMMIT           makeCommitment(label, you, secret, 0, resolver, 1y, 0) → commit
 *   MINT_USDC        MockUSDC.mint(you, shortfall)   (testnet token, open mint)
 *   APPROVE_USDC     MockUSDC.approve(ETHRegistrar, price)
 *   WAIT_COMMITMENT  until MIN_COMMITMENT_AGE (60 s) has passed on-chain
 *   REGISTER         ETHRegistrar.register(..., MockUSDC, 0)
 *   SET_TEXT         resolver.setText(dnsName, key, value) for each desired record
 *
 * Safety: Sepolia only (chain id checked); the commitment secret is saved to
 * .secrets/ before the commit tx; every write is simulated first; tx hashes
 * are saved as soon as they are sent, so a re-run resumes. Keys and the RPC
 * URL are never printed.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  parseEventLogs,
  privateKeyToAccount,
  sepolia,
  type Address,
  type Hash,
} from '../../packages/ens/src/viem.ts';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  ALL_RESOLVER_ROLES,
  ENSV2_SEPOLIA,
  REGISTRATION_SECONDS,
  SEPOLIA_CHAIN_ID,
  ZERO_ADDRESS,
  ZERO_REFERRER,
  dnsEncode,
  ethRegistrarAbi,
  isTerminal,
  loadRegistration,
  mockErc20Abi,
  newRegistration,
  nextStep,
  ownedResolverSalt,
  parseParentLabel,
  permissionedResolverAbi,
  rentPriceOracleAbi,
  saveRegistration,
  sepoliaEtherscanAddress,
  sepoliaEtherscanTx,
  verifiableFactoryAbi,
  type RegistrationFacts,
  type StoredRegistration,
} from '../../packages/ens/src/index.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const REPO_URL = 'https://github.com/Chirag126/-hedera-ens-0g-agent-economy';
const MIN_ETH = 10n ** 16n; // 0.01 Sepolia ETH covers every step with a wide margin

const env = loadEnv(['ens-admin'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia')
  throw new Error('this script runs on Sepolia only (ENS_CHAIN=sepolia)');
const { name, label } = parseParentLabel(env.require('ENS_PARENT_NAME'));
const account = privateKeyToAccount(env.require('ENS_ADMIN_PRIVATE_KEY') as `0x${string}`);
const transport = http(env.require('ETH_RPC_URL'), { timeout: 30_000, retryCount: 1 });
const client = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ chain: sepolia, transport, account });
const confirm = hasFlag('--confirm');
const resolverOverride = argValue('--resolver');

const DESIRED_TEXT: Record<string, string> = {
  description:
    'Parent name for threat-intel provider agents (Hedera x ENSv2 x 0G agent economy, Sepolia).',
  url: REPO_URL,
};

const chainId = await client.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID)
  throw new Error(`ETH_RPC_URL is chain ${chainId}, not Sepolia (${SEPOLIA_CHAIN_ID})`);

const statePath = join('.secrets', `ens-registration-${label}.json`);
const expected = { chainId, name, owner: account.address };
let state: StoredRegistration =
  loadRegistration(statePath, expected) ??
  newRegistration({ ...expected, label, secret: `0x${randomBytes(32).toString('hex')}` });
if (resolverOverride !== undefined) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(resolverOverride))
    throw new Error('--resolver must be an address');
  state = { ...state, resolver: resolverOverride };
}
// Persist immediately: the secret must exist on disk before any commit.
saveRegistration(statePath, state);
const update = (patch: Partial<StoredRegistration>) => {
  state = { ...state, ...patch };
  saveRegistration(statePath, state);
};

const R = ENSV2_SEPOLIA;
const dnsName = dnsEncode(name);
const startedAt = new Date().toISOString();
const txLog: { step: string; hash: Hash; url: string }[] = [];

console.log(
  `ENSv2 parent-name registration on Sepolia ${confirm ? '(CONFIRM: sending transactions)' : '(dry run: read-only)'}`,
);
console.log(`  name         ${name}  (label "${label}")`);
console.log(`  owner        ${account.address}`);
console.log(`  registrar    ${R.ethRegistrar}`);
console.log(`  state file   ${statePath} (gitignored; holds the commitment secret)\n`);

async function readText(key: string): Promise<string | null> {
  try {
    return await client.getEnsText({ name, key, universalResolverAddress: R.universalResolver });
  } catch {
    return null;
  }
}

async function gatherFacts(): Promise<RegistrationFacts & { decimals: number }> {
  const owner = account.address;
  const [ethBalance, available, usdcBalance, allowance, minAge, maxAge, block, oracle, decimals] =
    await Promise.all([
      client.getBalance({ address: owner }),
      client.readContract({
        address: R.ethRegistrar,
        abi: ethRegistrarAbi,
        functionName: 'isAvailable',
        args: [label],
      }),
      client.readContract({
        address: R.mockUsdc,
        abi: mockErc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      }),
      client.readContract({
        address: R.mockUsdc,
        abi: mockErc20Abi,
        functionName: 'allowance',
        args: [owner, R.ethRegistrar],
      }),
      client.readContract({
        address: R.ethRegistrar,
        abi: ethRegistrarAbi,
        functionName: 'MIN_COMMITMENT_AGE',
      }),
      client.readContract({
        address: R.ethRegistrar,
        abi: ethRegistrarAbi,
        functionName: 'MAX_COMMITMENT_AGE',
      }),
      client.getBlock({ blockTag: 'latest' }),
      client.readContract({
        address: R.ethRegistrar,
        abi: ethRegistrarAbi,
        functionName: 'rentPriceOracle',
      }),
      client.readContract({ address: R.mockUsdc, abi: mockErc20Abi, functionName: 'decimals' }),
    ]);
  // getRegisterPrice reverts once the name is taken (seen live 2026-10-26:
  // custom error 0x477707e8 right after our own register tx), so the price is
  // only read while the name is still available. Afterwards it is irrelevant.
  const [base, premium] = available
    ? await client.readContract({
        address: R.ethRegistrar,
        abi: ethRegistrarAbi,
        functionName: 'getRegisterPrice',
        args: [label, REGISTRATION_SECONDS, R.mockUsdc],
      })
    : [0n, 0n];
  const paymentTokenAccepted = await client.readContract({
    address: oracle,
    abi: rentPriceOracleAbi,
    functionName: 'isPaymentToken',
    args: [R.mockUsdc],
  });
  const committedAt =
    state.commitment === null
      ? 0n
      : await client.readContract({
          address: R.ethRegistrar,
          abi: ethRegistrarAbi,
          functionName: 'commitmentAt',
          args: [state.commitment as Hash],
        });
  const currentText: Record<string, string | null> = {};
  if (!available)
    for (const key of Object.keys(DESIRED_TEXT)) currentText[key] = await readText(key);
  return {
    ethBalance,
    minEth: MIN_ETH,
    available,
    paymentTokenAccepted,
    priceTotal: base + premium,
    usdcBalance,
    allowance,
    now: block.timestamp,
    minCommitmentAge: minAge,
    maxCommitmentAge: maxAge,
    committedAt,
    desiredText: DESIRED_TEXT,
    currentText,
    decimals,
  };
}

/** Simulate, send, record the hash immediately, then require a successful receipt. */
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

async function execute(step: ReturnType<typeof nextStep>, facts: RegistrationFacts): Promise<void> {
  const owner = account.address;
  switch (step.kind) {
    case 'DEPLOY_RESOLVER': {
      const salt = ownedResolverSalt(owner);
      const data = encodeFunctionData({
        abi: permissionedResolverAbi,
        functionName: 'initialize',
        args: [[{ account: owner, roleBitmap: ALL_RESOLVER_ROLES }], []],
      });
      const { request, result: predicted } = await client.simulateContract({
        account,
        address: R.verifiableFactory,
        abi: verifiableFactoryAbi,
        functionName: 'deployProxy',
        args: [R.permissionedResolverImpl, salt, data],
      });
      const receipt = await send('DEPLOY_RESOLVER', request, (h) => update({ resolverTx: h }));
      const log = parseEventLogs({
        abi: verifiableFactoryAbi,
        eventName: 'ProxyDeployed',
        logs: receipt.logs,
      })[0];
      const proxy = log?.args.proxyAddress ?? predicted;
      if (proxy.toLowerCase() !== predicted.toLowerCase())
        throw new Error('deployed proxy differs from the simulated address');
      update({ resolver: proxy });
      console.log(`  resolver ${proxy}  ${sepoliaEtherscanAddress(proxy)}`);
      return;
    }
    case 'COMMIT': {
      const commitment = await client.readContract({
        address: R.ethRegistrar,
        abi: ethRegistrarAbi,
        functionName: 'makeCommitment',
        args: [
          label,
          owner,
          state.secret as Hash,
          ZERO_ADDRESS,
          state.resolver as Address,
          REGISTRATION_SECONDS,
          ZERO_REFERRER,
        ],
      });
      update({ commitment, commitTx: null });
      const { request } = await client.simulateContract({
        account,
        address: R.ethRegistrar,
        abi: ethRegistrarAbi,
        functionName: 'commit',
        args: [commitment],
      });
      await send('COMMIT', request, (h) => update({ commitTx: h }));
      return;
    }
    case 'COMMIT_PENDING':
      await new Promise((r) => setTimeout(r, 5_000));
      return;
    case 'MINT_USDC': {
      const { request } = await client.simulateContract({
        account,
        address: R.mockUsdc,
        abi: mockErc20Abi,
        functionName: 'mint',
        args: [owner, facts.priceTotal - facts.usdcBalance],
      });
      await send('MINT_USDC', request, (h) => update({ mintTx: h }));
      return;
    }
    case 'APPROVE_USDC': {
      const { request } = await client.simulateContract({
        account,
        address: R.mockUsdc,
        abi: mockErc20Abi,
        functionName: 'approve',
        args: [R.ethRegistrar, facts.priceTotal],
      });
      await send('APPROVE_USDC', request, (h) => update({ approveTx: h }));
      return;
    }
    case 'WAIT_COMMITMENT': {
      const seconds = Number(step.waitSeconds ?? 0n) + 3;
      console.log(`  waiting ${seconds}s for the commitment to age on-chain ...`);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return;
    }
    case 'REGISTER': {
      const { request } = await client.simulateContract({
        account,
        address: R.ethRegistrar,
        abi: ethRegistrarAbi,
        functionName: 'register',
        args: [
          label,
          owner,
          state.secret as Hash,
          ZERO_ADDRESS,
          state.resolver as Address,
          REGISTRATION_SECONDS,
          R.mockUsdc,
          ZERO_REFERRER,
        ],
      });
      await send('REGISTER', request, (h) => update({ registerTx: h }));
      return;
    }
    case 'SET_TEXT': {
      const key = step.key ?? '';
      const { request } = await client.simulateContract({
        account,
        address: state.resolver as Address,
        abi: permissionedResolverAbi,
        functionName: 'setText',
        args: [dnsName, key, DESIRED_TEXT[key] ?? ''],
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
const unit = (v: bigint) => `${formatUnits(v, facts.decimals)} MockUSDC`;
console.log('preflight');
console.log(
  `  ETH balance        ${formatEther(facts.ethBalance)} (need ≥ ${formatEther(MIN_ETH)})`,
);
console.log(`  available          ${facts.available}`);
console.log(`  MockUSDC accepted  ${facts.paymentTokenAccepted}`);
console.log(
  `  price (1 year)     ${facts.available ? unit(facts.priceTotal) : 'n/a (already registered)'}`,
);
console.log(`  MockUSDC balance   ${unit(facts.usdcBalance)} · allowance ${unit(facts.allowance)}`);
console.log(`  commitment age     min ${facts.minCommitmentAge}s · max ${facts.maxCommitmentAge}s`);
console.log(`  resolver           ${state.resolver ?? '(none yet)'}\n`);

let step = nextStep(facts, state);
let guard = 0;
while (!isTerminal(step.kind)) {
  console.log(
    `next: ${step.kind}${step.key === undefined ? '' : ` (${step.key})`} — ${step.reason}`,
  );
  if (!confirm) {
    console.log('\nDRY RUN: nothing sent. Re-run with --confirm to execute the steps.');
    break;
  }
  if (++guard > 25)
    throw new Error('too many steps; stopping to avoid a loop (state is saved; re-run to resume)');
  await execute(step, facts);
  facts = await gatherFacts();
  step = nextStep(facts, state);
}
if (isTerminal(step.kind)) console.log(`\n${step.kind}: ${step.reason}`);

// Independent read-back through the Universal Resolver (viem's ENS helpers).
let resolution: {
  resolver: string | null;
  text: Record<string, string | null>;
  matches: boolean;
} | null = null;
if (step.kind === 'DONE') {
  const resolver = await client.getEnsResolver({
    name,
    universalResolverAddress: R.universalResolver,
  });
  const text: Record<string, string | null> = {};
  for (const key of Object.keys(DESIRED_TEXT)) text[key] = await readText(key);
  const matches =
    resolver.toLowerCase() === (state.resolver ?? '').toLowerCase() &&
    Object.entries(DESIRED_TEXT).every(([k, v]) => text[k] === v);
  resolution = { resolver, text, matches };
  console.log('\nresolution via the Universal Resolver (viem getEnsResolver / getEnsText)');
  console.log(
    `  resolver   ${resolver} ${resolver.toLowerCase() === (state.resolver ?? '').toLowerCase() ? '(ours)' : '(NOT ours)'}`,
  );
  for (const [k, v] of Object.entries(text)) console.log(`  ${k.padEnd(11)}${JSON.stringify(v)}`);
}

if (hasFlag('--save-evidence')) {
  const path = writeEvidence(
    'ens',
    resolution?.matches === true ? 'parent-registration' : 'parent-registration-attempt',
    {
      kind: 'ens-parent-registration',
      startedAt,
      finishedAt: new Date().toISOString(),
      chain: 'sepolia',
      chainId,
      name,
      label,
      owner: account.address,
      contracts: R,
      // Quoted only while the name is available; null once registered (the
      // amount paid is in the register tx's MockUSDC transfer on Etherscan).
      quotedPrice: facts.available ? facts.priceTotal : null,
      paymentToken: R.mockUsdc,
      durationSeconds: REGISTRATION_SECONDS,
      resolver: state.resolver,
      transactions: {
        resolverDeploy: state.resolverTx,
        commit: state.commitTx,
        mintMockUsdc: state.mintTx,
        approveMockUsdc: state.approveTx,
        register: state.registerTx,
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
    `\nREGISTERED AND RESOLVED: ${name} resolves through the Universal Resolver to our resolver, with the text records we set.`,
  );
} else if (step.kind !== 'DONE' && !confirm) {
  // dry run: informational exit
} else {
  process.exitCode = 1;
}
