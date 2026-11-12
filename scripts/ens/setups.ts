/**
 * ENSv2 subname setups on Sepolia (D-066): expiring, transferable vs
 * locked, a wildcard default record and a record alias. See
 * packages/ens/src/setups.ts for what each one is and why it is safe.
 *
 *   pnpm ens:setups                                   dry run: every write simulated
 *   pnpm ens:setups -- --confirm --save-evidence      send, then read everything back
 *   pnpm ens:setups -- --check --save-evidence        read the recorded setups again (e.g.
 *                                                     after the trial expired)
 *
 * Transactions (admin key, Sepolia gas), new labels only:
 *   1. register trial-<stamp>   expiry = now + --trial-minutes (default 30)
 *   2. register movable-<stamp> with the transfer right, then unsafeTransfer it to kev's operator
 *   3. register locked-<stamp>  without it; the same transfer is simulated and must revert
 *      TransferDisallowed (nothing is sent for the refusal)
 *   4. parent resolver: setText(root 0x00, "description", …), the default record
 *   5. parent resolver: linkToNode(directory-<stamp>.<parent>, namehash(<parent>))
 * Read back through the Universal Resolver and the registry: status, expiry,
 * owner, the wildcard and alias texts, and the parent's own records unchanged.
 * Writes deployments/sepolia-setups.json (no hashes or timestamps) only from
 * verified reads; hashes go to the evidence file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  ENSV2_SEPOLIA,
  LOCKED_ROLES,
  REGISTRY_STATUS,
  SEPOLIA_CHAIN_ID,
  SETUPS_PATH,
  TRANSFERABLE_ROLES,
  ZERO_ADDRESS,
  dnsEncode,
  labelId,
  parseDeployment,
  parseParentLabel,
  parseSetups,
  permissionedRegistryAbi,
  permissionedResolverAbi,
  sepoliaEtherscanTx,
  serializeSetups,
  setupLabels,
  trialExpiry,
  type EnsSetup,
} from '../../packages/ens/src/index.ts';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  namehash,
  parseEther,
  parseEventLogs,
  privateKeyToAccount,
  sepolia,
  type Address,
  type Hash,
} from '../../packages/ens/src/viem.ts';
import {
  UsageError,
  argValue,
  fileStamp,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';
import { writeWithFixedNonce } from '../lib/rpc-write.ts';

handleScriptErrors();

class SetupsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupsError';
  }
}

const DEFAULT_TEXT = (parent: string) =>
  `No agent is listed at this name. ${parent} lists its provider agents as kev, cve and osv.`;
const MIN_ETH = parseEther('0.01');
const env = loadEnv(['ens-admin'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia')
  throw new SetupsError('this script runs on Sepolia only');
const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
const admin = privateKeyToAccount(env.require('ENS_ADMIN_PRIVATE_KEY') as `0x${string}`);
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
const universalResolverAddress = ENSV2_SEPOLIA.universalResolver;
const confirm = hasFlag('--confirm');
const checkOnly = hasFlag('--check');
if (confirm && checkOnly) throw new UsageError('use --confirm or --check, not both');

if ((await client.getChainId()) !== SEPOLIA_CHAIN_ID)
  throw new SetupsError('ETH_RPC_URL is not Sepolia');
const deployment = parseDeployment(readFileSync('deployments/sepolia.json', 'utf8'));
const registry = deployment.subregistry as Address;
const kevOperator = deployment.agents.find((a) => a.label === 'kev')?.operator as
  Address | undefined;
if (kevOperator === undefined)
  throw new SetupsError('deployments/sepolia.json has no kev operator');
const parentResolver = (await client.getEnsResolver({
  name: parent.name,
  universalResolverAddress,
})) as Address;
const parentTextBefore = {
  description: await client.getEnsText({
    name: parent.name,
    key: 'description',
    universalResolverAddress,
  }),
  url: await client.getEnsText({ name: parent.name, key: 'url', universalResolverAddress }),
};

const startedAt = new Date().toISOString();
const sent: { step: string; hash: Hash; url: string; block: string }[] = [];
async function send(step: string, request: Parameters<typeof wallet.writeContract>[0]) {
  const hash = await writeWithFixedNonce({
    nonce: pendingNonce,
    write: (nonce) => wallet.writeContract({ ...request, nonce }),
    log: (line) => console.log(line),
  });
  console.log(`  ${step}: sent ${hash}  ${sepoliaEtherscanTx(hash)}`);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== 'success') throw new SetupsError(`${step}: ${hash} reverted`);
  sent.push({ step, hash, url: sepoliaEtherscanTx(hash), block: receipt.blockNumber.toString() });
  return receipt;
}
const text = (name: string, key: string) =>
  client.getEnsText({ name, key, universalResolverAddress }).catch(() => null);
const statusOf = async (label: string) =>
  Number(
    await client.readContract({
      address: registry,
      abi: permissionedRegistryAbi,
      functionName: 'getStatus',
      args: [labelId(label)],
    }),
  );
const ownerOf = (label: string) =>
  client.readContract({
    address: registry,
    abi: permissionedRegistryAbi,
    functionName: 'getOwner',
    args: [labelId(label)],
  });
const expiryOf = (label: string) =>
  client.readContract({
    address: registry,
    abi: permissionedRegistryAbi,
    functionName: 'getExpiry',
    args: [labelId(label)],
  });

/** Simulate a transfer from the admin; returns the revert error name, or null if it would succeed. */
async function transferRevert(label: string): Promise<string | null> {
  const tokenId = await client.readContract({
    address: registry,
    abi: permissionedRegistryAbi,
    functionName: 'getTokenId',
    args: [labelId(label)],
  });
  try {
    await client.simulateContract({
      account: admin,
      address: registry,
      abi: permissionedRegistryAbi,
      functionName: 'unsafeTransfer',
      args: [kevOperator as Address, tokenId, '0x'],
    });
    return null;
  } catch (error) {
    const reverted =
      error instanceof BaseError
        ? error.walk((e) => e instanceof ContractFunctionRevertedError)
        : null;
    return reverted instanceof ContractFunctionRevertedError
      ? (reverted.data?.errorName ?? 'reverted')
      : 'reverted';
  }
}

// ── which names: a new set (--confirm or dry run) or the recorded one (--check) ──
const recorded = existsSync(SETUPS_PATH)
  ? parseSetups(JSON.parse(readFileSync(SETUPS_PATH, 'utf8')))
  : null;
let labels: ReturnType<typeof setupLabels>;
if (checkOnly) {
  if (recorded === null) throw new UsageError(`no ${SETUPS_PATH} yet: run with --confirm first`);
  const byKind = (k: string) => recorded.setups.find((s) => s.kind === k)?.name.split('.')[0] ?? '';
  labels = {
    expiring: byKind('expiring'),
    transferable: byKind('transferable'),
    locked: byKind('locked'),
    wildcard: byKind('wildcard'),
    alias: byKind('alias'),
  };
} else labels = setupLabels(fileStamp().toLowerCase());
const fqdn = (label: string) => `${label}.${parent.name}`;
const parentExpiry = await client.readContract({
  address: ENSV2_SEPOLIA.ethRegistry,
  abi: permissionedRegistryAbi,
  functionName: 'getExpiry',
  args: [labelId(parent.label)],
});
const head = await client.getBlock();
const trialMinutes = Number(argValue('--trial-minutes') ?? '30');
const trialUntil = trialExpiry(head.timestamp, trialMinutes);

console.log(
  `ENSv2 subname setups on Sepolia ${checkOnly ? '(check)' : confirm ? '(CONFIRM: sending transactions)' : '(dry run)'}`,
);
console.log(
  `  parent ${parent.name} · subregistry ${registry} · parent resolver ${parentResolver}`,
);
for (const [k, l] of Object.entries(labels)) console.log(`  ${k.padEnd(12)} ${fqdn(l)}`);

const register = (label: string, roles: bigint, expiry: bigint) =>
  ({
    account: admin,
    address: registry,
    abi: permissionedRegistryAbi,
    functionName: 'register',
    args: [label, admin.address, ZERO_ADDRESS, ZERO_ADDRESS, roles, expiry],
  }) as const;
const writes = [
  { step: 'register trial (expiring)', req: register(labels.expiring, LOCKED_ROLES, trialUntil) },
  {
    step: 'register movable (transferable)',
    req: register(labels.transferable, TRANSFERABLE_ROLES, parentExpiry),
  },
  {
    step: 'register locked (not transferable)',
    req: register(labels.locked, LOCKED_ROLES, parentExpiry),
  },
  {
    step: 'default record on the parent resolver (wildcard)',
    req: {
      account: admin,
      address: parentResolver,
      abi: permissionedResolverAbi,
      functionName: 'setText',
      args: ['0x00', 'description', DEFAULT_TEXT(parent.name)],
    } as const,
  },
  {
    step: 'link directory name to the parent record (alias)',
    req: {
      account: admin,
      address: parentResolver,
      abi: permissionedResolverAbi,
      functionName: 'linkToNode',
      args: [dnsEncode(fqdn(labels.alias)), namehash(parent.name)],
    } as const,
  },
];

if (!checkOnly) {
  for (const w of writes) {
    await client.simulateContract(
      w.req as unknown as Parameters<typeof client.simulateContract>[0],
    );
    console.log(`  simulated: ${w.step}`);
  }
  const balance = await client.getBalance({ address: admin.address });
  console.log(`  admin balance ${formatEther(balance)} ETH`);
  if (confirm) {
    if (balance < MIN_ETH)
      throw new SetupsError(`fund the admin with at least ${formatEther(MIN_ETH)} Sepolia ETH`);
    for (const w of writes)
      await send(w.step, w.req as unknown as Parameters<typeof wallet.writeContract>[0]);
    // the transferable name really moves: to kev's operator
    const tokenId = await client.readContract({
      address: registry,
      abi: permissionedRegistryAbi,
      functionName: 'getTokenId',
      args: [labelId(labels.transferable)],
    });
    const moved = await send('transfer movable to kev operator', {
      account: admin,
      address: registry,
      abi: permissionedRegistryAbi,
      functionName: 'unsafeTransfer',
      args: [kevOperator, tokenId, '0x'],
    });
    if (parseEventLogs({ abi: permissionedRegistryAbi, logs: moved.logs }).length === 0)
      console.log('  note: no registry event decoded from the transfer receipt');
  }
}

// ── read everything back ─────────────────────────────────────────────────
const nowSec = (await client.getBlock()).timestamp;
const facts = {
  trial: {
    status: await statusOf(labels.expiring),
    expiry: (await expiryOf(labels.expiring)).toString(),
  },
  movable: {
    owner: await ownerOf(labels.transferable),
    status: await statusOf(labels.transferable),
  },
  locked: {
    owner: await ownerOf(labels.locked),
    transferRevert:
      (await statusOf(labels.locked)) === REGISTRY_STATUS.REGISTERED
        ? await transferRevert(labels.locked)
        : null,
  },
  wildcard: { description: await text(fqdn(labels.wildcard), 'description') },
  alias: {
    url: await text(fqdn(labels.alias), 'url'),
    description: await text(fqdn(labels.alias), 'description'),
  },
  parentAfter: {
    description: await text(parent.name, 'description'),
    url: await text(parent.name, 'url'),
  },
};
const trialExpired = nowSec >= BigInt(facts.trial.expiry);
const checks = {
  trialRegisteredWithItsExpiry: trialExpired
    ? facts.trial.status === REGISTRY_STATUS.AVAILABLE
    : facts.trial.status === REGISTRY_STATUS.REGISTERED,
  movableNowOwnedByKevOperator: facts.movable.owner.toLowerCase() === kevOperator.toLowerCase(),
  lockedStaysWithAdmin: facts.locked.owner.toLowerCase() === admin.address.toLowerCase(),
  lockedTransferRefused: facts.locked.transferRevert === 'TransferDisallowed',
  wildcardServesDefaultRecord: facts.wildcard.description === DEFAULT_TEXT(parent.name),
  aliasSharesParentRecord:
    facts.alias.url === parentTextBefore.url &&
    facts.alias.description === parentTextBefore.description,
  parentRecordsUnchanged:
    facts.parentAfter.description === parentTextBefore.description &&
    facts.parentAfter.url === parentTextBefore.url,
};
console.log(
  `\nchecks (block time ${nowSec}; trial ${trialExpired ? 'expired' : `until ${facts.trial.expiry}`})`,
);
for (const [k, v] of Object.entries(checks))
  console.log(`  ${v ? 'PASS' : confirm || checkOnly ? 'FAIL' : '----'} ${k}`);
const verified = (confirm || checkOnly) && Object.values(checks).every(Boolean);

if (verified) {
  const setups: EnsSetup[] = [
    {
      kind: 'expiring',
      name: fqdn(labels.expiring),
      expiry: facts.trial.expiry,
      owner: admin.address,
      proof:
        'Registered with a short expiry; the registry treats it as available once the expiry passes, and discovery skips it.',
    },
    {
      kind: 'transferable',
      name: fqdn(labels.transferable),
      expiry: parentExpiry.toString(),
      owner: kevOperator,
      proof: "Registered with the transfer right and moved to kev's operator with unsafeTransfer.",
    },
    {
      kind: 'locked',
      name: fqdn(labels.locked),
      expiry: parentExpiry.toString(),
      owner: admin.address,
      proof: 'Registered without the transfer right; a transfer reverts TransferDisallowed.',
    },
    {
      kind: 'wildcard',
      name: fqdn(labels.wildcard),
      expiry: null,
      owner: null,
      proof:
        "Not registered; resolves to the parent resolver's default record through the Universal Resolver.",
    },
    {
      kind: 'alias',
      name: fqdn(labels.alias),
      expiry: null,
      owner: null,
      proof: "Linked with linkToNode; resolves to the parent's own records.",
    },
  ];
  const textOut = serializeSetups({
    kind: 'ens-setups',
    version: 1,
    parent: parent.name,
    subregistry: registry,
    parentResolver,
    setups,
  });
  const before = existsSync(SETUPS_PATH) ? readFileSync(SETUPS_PATH, 'utf8') : '';
  if (textOut !== before) writeFileSync(SETUPS_PATH, textOut, 'utf8');
  console.log(`\n${SETUPS_PATH} ${textOut === before ? 'unchanged' : 'written'}`);
}

if (hasFlag('--save-evidence')) {
  const path = writeEvidence('ens', verified ? 'setups' : 'setups-attempt', {
    kind: 'ens-setups',
    mode: checkOnly ? 'check' : confirm ? 'confirm' : 'dry-run',
    startedAt,
    finishedAt: new Date().toISOString(),
    parent: parent.name,
    subregistry: registry,
    parentResolver,
    labels,
    sentThisRun: sent,
    blockTime: nowSec.toString(),
    trialExpired,
    facts,
    parentTextBefore,
    checks,
    verified,
  });
  console.log(`Evidence written to ${path}`);
}
console.log(verified ? '\nVERIFIED.' : '\nNOT VERIFIED: see above.');
if (!verified && (confirm || checkOnly)) process.exitCode = 1;
