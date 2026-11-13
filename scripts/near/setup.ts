/**
 * One-time setup on NEAR, run by the owner on their own machine.
 *
 *   pnpm near:setup                                  show what would be done
 *   pnpm near:setup -- --confirm                     do it
 *   pnpm near:setup -- --confirm --wasm <file>       use another build of the contract
 *   pnpm near:setup -- --confirm --new-agent-key     add a fresh function-call key to the agent
 *                                                    (lost key file, or its gas allowance ran out)
 *
 * With NEAR_OWNER_ACCOUNT_ID = owner.testnet it creates, where missing:
 *
 *   guard.owner.testnet   the spending guard contract (deployed and initialised)
 *   agent.owner.testnet   the agent account, with ONE function-call key for the server,
 *                         scoped to the guard contract (methods pay, attest, report)
 *   kev. cve. osv.        the providers' payout accounts
 *
 * then registers the providers in the guard's registry. Every step checks the
 * chain first, so the script can be run again after a failure.
 *
 * Keys: NEAR_OWNER_PRIVATE_KEY (full access) stays in your local .env and is
 * never deployed. The owner's key is also added to the sub-accounts as their
 * full-access key, so the owner can renew the agent's function-call key. The
 * agent's new function-call key is written to .secrets/near-keys.json (not
 * committed); only that key goes to the server.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnv } from '../../packages/core/src/index.ts';
import { AGENTS } from '../../packages/ens/src/agents.ts';
import {
  GuardReader,
  NearRpc,
  generateKeyPair,
  jsonArgs,
  parseNear,
  signTransaction,
  signerFromSecretKey,
  type NearAction,
  type NearNetwork,
} from '../../packages/near/src/index.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';
import { explorerAccount, explorerTx, near } from './lib.ts';

handleScriptErrors();

class NearSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NearSetupError';
  }
}

const source = loadLocalEnvSource();
const env = loadEnv(['near-admin', 'near-providers'], {
  // the guard and provider accounts are derived below; these two are not needed to run setup
  ...source,
  NEAR_GUARD_CONTRACT_ID: source['NEAR_GUARD_CONTRACT_ID'] || 'placeholder.testnet',
  NEAR_PROVIDER_ACCOUNTS: source['NEAR_PROVIDER_ACCOUNTS'] || 'kev:placeholder.testnet',
});
const confirm = hasFlag('--confirm');
const network = `near:${env.require('NEAR_NETWORK')}` as NearNetwork;
const owner = env.require('NEAR_OWNER_ACCOUNT_ID');
const signer = signerFromSecretKey(env.require('NEAR_OWNER_PRIVATE_KEY'));
const rpc = new NearRpc({ url: env.require('NEAR_NODE_URL') });
const publicUrl = (source['PROVIDERS_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^\s/]+$|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(publicUrl))
  throw new NearSetupError(
    'set PROVIDERS_PUBLIC_URL to the provider service origin (https://…): the registry stores each provider endpoint',
  );
const price = parseNear(env.require('NEAR_PRICE'));
const wasmPath = argValue('--wasm') ?? 'contracts/guard/res/endersift_guard.wasm';

const guardId = `guard.${owner}`;
const agentId = `agent.${owner}`;
const providers = AGENTS.map((a) => ({
  label: a.label,
  accountId: `${a.label}.${owner}`,
  description: a.description,
}));
const KEY_FILE = '.secrets/near-keys.json';
const AGENT_METHODS = ['pay', 'attest', 'report'];
const TGAS = 1_000_000_000_000n;
// the caps the guard starts with; change them later with set_policy (owner only)
const POLICY = {
  max_per_payment: parseNear('0.01').toString(),
  max_per_run: parseNear('0.05').toString(),
  max_per_day: parseNear('0.2').toString(),
  max_payments_per_run: 10,
};

const done: { step: string; hash: string | null }[] = [];

/** Send one transaction signed with the owner's key (it is a full-access key on every account here). */
async function send(step: string, signerId: string, receiverId: string, actions: NearAction[]) {
  if (!confirm) {
    console.log(`  would: ${step}`);
    return;
  }
  const key = await rpc.accessKey(signerId, signer.publicKey);
  if (key === null)
    throw new NearSetupError(`the owner key is not an access key of ${signerId}; cannot ${step}`);
  if (key.permission.kind !== 'fullAccess')
    throw new NearSetupError(`the owner key on ${signerId} is not a full-access key`);
  const signed = signTransaction(
    {
      signerId,
      publicKey: signer.publicKeyBytes,
      nonce: key.nonce + 1n,
      receiverId,
      blockHash: key.blockHash,
      actions,
    },
    signer,
  );
  const outcome = await rpc.sendTransaction(signed.base64, 'FINAL');
  if (!outcome.success) throw new NearSetupError(`${step} failed: ${outcome.failure ?? 'unknown'}`);
  done.push({ step, hash: outcome.hash });
  console.log(`  done:  ${step}\n         ${explorerTx(network, outcome.hash)}`);
}

/** The agent's key: it can call pay, attest and report on the guard, and nothing else. */
function agentKeyAction(secretKey: string): NearAction {
  return {
    kind: 'addKey',
    publicKey: signerFromSecretKey(secretKey).publicKeyBytes,
    permission: {
      kind: 'functionCall',
      receiverId: guardId,
      methodNames: AGENT_METHODS,
      // gas the key may spend from the agent account before it must be renewed
      allowance: parseNear('0.25'),
    },
  };
}

function keyFile(pair: { publicKey: string; secretKey: string }): string {
  const content = {
    network,
    agentAccountId: agentId,
    guardContractId: guardId,
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
  };
  return `${JSON.stringify(content, null, 2)}\n`;
}

const ownerKey: NearAction = {
  kind: 'addKey',
  publicKey: signer.publicKeyBytes,
  permission: { kind: 'fullAccess' },
};

console.log(
  `NEAR setup on ${network} as ${owner}${confirm ? '' : ' (dry run: add --confirm to send)'}\n`,
);

const ownerAccount = await rpc.viewAccount(owner);
if (ownerAccount === null) throw new NearSetupError(`${owner} does not exist on ${network}`);
console.log(`  owner balance: ${near(ownerAccount.amount)}`);

// 1. the guard account and contract
const guardAccount = await rpc.viewAccount(guardId);
let code: Uint8Array | null = null;
if (guardAccount?.codeHash === null || guardAccount === null) {
  if (!existsSync(wasmPath))
    throw new NearSetupError(
      `${wasmPath} not found. Download the artifact "endersift-guard-wasm" from the latest "NEAR contract" run on GitHub Actions and unzip it there, or pass --wasm <file>.`,
    );
  code = Uint8Array.from(readFileSync(wasmPath));
}
if (guardAccount === null) {
  // storage costs 1 NEAR per 100 kB; add 1 NEAR for the contract's state and the first budget
  const deposit = BigInt(code?.length ?? 0) * 10n ** 19n + parseNear('1');
  await send(`create ${guardId} with ${near(deposit)}`, owner, guardId, [
    { kind: 'createAccount' },
    { kind: 'transfer', deposit },
    ownerKey,
  ]);
}
if (code !== null) {
  await send(
    `deploy the guard contract (${code.length} bytes) and initialise it`,
    guardId,
    guardId,
    [
      { kind: 'deployContract', code },
      {
        kind: 'functionCall',
        method: 'new',
        args: jsonArgs({ owner, agent: agentId, policy: POLICY }),
        gas: 100n * TGAS,
        deposit: 0n,
      },
    ],
  );
} else {
  console.log(`  ok:    ${guardId} already has a contract`);
}

// 2. the agent account with its function-call key
let agentKey: { publicKey: string; secretKey: string } | null = null;
if ((await rpc.viewAccount(agentId)) === null) {
  agentKey = generateKeyPair();
  if (confirm) {
    // written before sending: if the transaction lands and the script stops, the key is not lost
    mkdirSync('.secrets', { recursive: true });
    writeFileSync(KEY_FILE, keyFile(agentKey), { encoding: 'utf8', mode: 0o600 });
  }
  await send(`create ${agentId} with a function-call key for ${guardId}`, owner, agentId, [
    { kind: 'createAccount' },
    { kind: 'transfer', deposit: parseNear('0.5') },
    ownerKey,
    agentKeyAction(agentKey.secretKey),
  ]);
} else if (hasFlag('--new-agent-key')) {
  agentKey = generateKeyPair();
  if (confirm) {
    mkdirSync('.secrets', { recursive: true });
    writeFileSync(KEY_FILE, keyFile(agentKey), { encoding: 'utf8', mode: 0o600 });
  }
  await send(`add a new function-call key for ${guardId} to ${agentId}`, agentId, agentId, [
    agentKeyAction(agentKey.secretKey),
  ]);
} else {
  console.log(`  ok:    ${agentId} exists (its key is in ${KEY_FILE} from the first run)`);
}

// 3. the providers' payout accounts
for (const p of providers) {
  if ((await rpc.viewAccount(p.accountId)) === null)
    await send(`create ${p.accountId}`, owner, p.accountId, [
      { kind: 'createAccount' },
      { kind: 'transfer', deposit: parseNear('0.05') },
      ownerKey,
    ]);
  else console.log(`  ok:    ${p.accountId} exists`);
}

// 4. the registry
const reader = new GuardReader(rpc, guardId);
const guardLive = confirm || (guardAccount !== null && guardAccount.codeHash !== null);
const registered = guardLive ? await reader.providers().catch(() => []) : [];
for (const p of providers) {
  const endpoint = `${publicUrl}/near/v1/${p.label}`;
  const current = registered.find((r) => r.accountId === p.accountId);
  if (current !== undefined && current.endpoint === endpoint && current.price === price) {
    console.log(`  ok:    ${p.label} is registered at ${endpoint}`);
    continue;
  }
  await send(`register ${p.label} at ${endpoint} for ${near(price)}`, owner, guardId, [
    {
      kind: 'functionCall',
      method: 'register_provider',
      args: jsonArgs({
        account_id: p.accountId,
        label: p.label,
        endpoint,
        description: p.description.slice(0, 500),
        price: price.toString(),
        code_hash: '',
      }),
      gas: 30n * TGAS,
      deposit: 0n,
    },
  ]);
}

if (!confirm) {
  console.log('\nNothing was sent. Run again with --confirm.');
} else {
  const status = await reader.status();
  console.log(`\nGuard ${guardId}: balance ${near(status.balance)}, ${status.providers} providers`);
  console.log(`  ${explorerAccount(network, guardId)}`);
  const path = writeEvidence('near', 'setup', {
    kind: 'near-setup',
    at: new Date().toISOString(),
    network,
    owner,
    guard: guardId,
    agent: agentId,
    agentKeyMethods: AGENT_METHODS,
    providers: providers.map((p) => ({ label: p.label, accountId: p.accountId })),
    policy: POLICY,
    transactions: done,
  });
  console.log(`Evidence written to ${path}`);
  console.log('\nSet these (in .env, and on Render for the two services):');
  console.log(`  NEAR_GUARD_CONTRACT_ID=${guardId}`);
  console.log(`  NEAR_AGENT_ACCOUNT_ID=${agentId}`);
  console.log(
    `  NEAR_PROVIDER_ACCOUNTS=${providers.map((p) => `${p.label}:${p.accountId}`).join(',')}`,
  );
  console.log(
    agentKey === null
      ? `  NEAR_AGENT_PRIVATE_KEY=<secretKey from ${KEY_FILE}>`
      : `  NEAR_AGENT_PRIVATE_KEY=<secretKey from ${KEY_FILE}, written just now>`,
  );
}
