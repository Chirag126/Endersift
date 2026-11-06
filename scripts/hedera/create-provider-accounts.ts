/**
 * Create the provider payout accounts on Hedera, funded by the payer.
 *
 *   pnpm hedera:create-providers                     dry run: shows the plan, spends nothing
 *   pnpm hedera:create-providers -- --confirm        creates accounts (spends testnet HBAR)
 *   pnpm hedera:create-providers -- --labels kev,cve,osv --initial-hbar 2 --confirm
 *
 * Safety:
 *  - Refuses to run on mainnet.
 *  - Labels already present in HEDERA_PROVIDER_ACCOUNTS are skipped (idempotent).
 *  - Each new private key is written to .secrets/hedera-provider-keys.json
 *    (gitignored) BEFORE the account-creation transaction is submitted, so a
 *    crash can never leave a funded account whose key is lost.
 *  - Keys are never printed. The evidence file contains account IDs,
 *    transaction IDs and HashScan links only, and passes the secret scanner.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  loadEnv,
  parseLabelledAccounts,
  type LabelledAccount,
} from '../../packages/core/src/index.ts';
import {
  formatHbar,
  hashscanAccountUrl,
  hashscanTransactionUrl,
  parseHbar,
} from '../../packages/hedera/src/index.ts';
import {
  createAccount,
  createClient,
  generateEcdsaKey,
  parsePrivateKey,
  publicKeyHex,
  type KeyType,
} from '../../packages/hedera/src/sdk.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const KEY_FILE = '.secrets/hedera-provider-keys.json';
const DEFAULT_LABELS = ['kev', 'cve', 'osv'];

interface KeyFileEntry {
  label: string;
  status: 'pending' | 'created';
  privateKeyDer: string;
  publicKey: string;
  accountId?: string;
  transactionId?: string;
  createdAt: string;
}

function readKeyFile(): KeyFileEntry[] {
  if (!existsSync(KEY_FILE)) return [];
  const parsed: unknown = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  if (!Array.isArray(parsed))
    throw new Error(`${KEY_FILE} is not a JSON array; fix or move it first`);
  return parsed as KeyFileEntry[];
}

function writeKeyFile(entries: KeyFileEntry[]): void {
  mkdirSync(dirname(KEY_FILE), { recursive: true });
  writeFileSync(KEY_FILE, `${JSON.stringify(entries, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

const source = loadLocalEnvSource();
const env = loadEnv(['core', 'hedera'], source);
const network = env.require('HEDERA_NETWORK') as 'testnet' | 'mainnet';
if (network !== 'testnet') {
  console.error('Refusing to create provider accounts on mainnet with this script.');
  process.exit(2);
}

const labels = (argValue('--labels') ?? DEFAULT_LABELS.join(','))
  .split(',')
  .map((l) => l.trim())
  .filter((l) => l !== '');
const initialHbar = argValue('--initial-hbar') ?? '2';
const initialTinybars = parseHbar(initialHbar);

// Validate labels with the same rules as HEDERA_PROVIDER_ACCOUNTS.
const labelCheck = parseLabelledAccounts(labels.map((l, i) => `${l}:0.0.${i + 1}`).join(','));
if (typeof labelCheck === 'string') {
  console.error(`Invalid --labels: ${labelCheck}`);
  process.exit(2);
}

const existingRaw = source['HEDERA_PROVIDER_ACCOUNTS']?.trim() ?? '';
const existingParsed = existingRaw === '' ? [] : parseLabelledAccounts(existingRaw);
if (typeof existingParsed === 'string') {
  console.error(`HEDERA_PROVIDER_ACCOUNTS is invalid: ${existingParsed}`);
  process.exit(2);
}
const existing: LabelledAccount[] = existingParsed;
const keyFile = readKeyFile();
const toCreate = labels.filter((l) => !existing.some((e) => e.label === l));
const pendingInFile = keyFile.filter((e) => e.status === 'pending' && toCreate.includes(e.label));

console.log(`Payer: ${env.require('HEDERA_PAYER_ACCOUNT_ID')} on ${network}`);
console.log(
  `Already configured: ${existing.map((e) => `${e.label}:${e.accountId}`).join(', ') || 'none'}`,
);
console.log(
  `To create: ${toCreate.join(', ') || 'none'} (initial balance ${formatHbar(initialTinybars)} HBAR each)`,
);
if (pendingInFile.length > 0) {
  console.error(
    `\n${KEY_FILE} has PENDING entries for: ${pendingInFile.map((e) => e.label).join(', ')}.\n` +
      'A previous run may have submitted a transaction without recording the result. Check the payer\n' +
      "account's recent transactions on HashScan before retrying, then remove those entries manually.",
  );
  process.exit(1);
}

if (toCreate.length === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}
if (!hasFlag('--confirm')) {
  console.log('\nDry run only. Re-run with --confirm to create these accounts on testnet.');
  process.exit(0);
}

const payerKey = parsePrivateKey(
  env.require('HEDERA_PAYER_PRIVATE_KEY'),
  env.require('HEDERA_PAYER_KEY_TYPE') as KeyType,
);
const client = createClient(network, env.require('HEDERA_PAYER_ACCOUNT_ID'), payerKey);
const created: { label: string; accountId: string; transactionId: string }[] = [];

try {
  for (const label of toCreate) {
    const key = generateEcdsaKey();
    const entry: KeyFileEntry = {
      label,
      status: 'pending',
      privateKeyDer: key.toStringDer(),
      publicKey: publicKeyHex(key),
      createdAt: new Date().toISOString(),
    };
    keyFile.push(entry);
    writeKeyFile(keyFile); // persist the key before any funds move

    const result = await createAccount(client, key, {
      initialBalanceTinybars: initialTinybars,
      memo: `agent-economy provider ${label}`,
    });
    entry.status = 'created';
    entry.accountId = result.accountId;
    entry.transactionId = result.transactionId;
    writeKeyFile(keyFile);
    created.push({ label, ...result });
    console.log(`created ${label}: ${result.accountId}  tx ${result.transactionId}`);
  }
} finally {
  client.close();
}

const all = [...existing, ...created.map((c) => ({ label: c.label, accountId: c.accountId }))];
const evidencePath = writeEvidence('hedera', 'provider-accounts', {
  kind: 'hedera-provider-account-creation',
  createdAt: new Date().toISOString(),
  network,
  payer: env.require('HEDERA_PAYER_ACCOUNT_ID'),
  initialBalanceHbar: formatHbar(initialTinybars),
  accounts: created.map((c) => ({
    label: c.label,
    accountId: c.accountId,
    transactionId: c.transactionId,
    accountHashscan: hashscanAccountUrl(network, c.accountId),
    transactionHashscan: hashscanTransactionUrl(network, c.transactionId),
  })),
});

console.log(`\nKeys saved to ${KEY_FILE} (gitignored; back it up somewhere private).`);
console.log(`Evidence written to ${evidencePath}`);
console.log('\nAdd or replace this line in your .env:\n');
console.log(`HEDERA_PROVIDER_ACCOUNTS=${all.map((a) => `${a.label}:${a.accountId}`).join(',')}`);
