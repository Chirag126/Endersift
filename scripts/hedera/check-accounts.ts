/**
 * Verify the payer and provider accounts against the Hedera Mirror Node.
 * Read-only: submits no transactions and spends nothing.
 *
 *   pnpm hedera:check-accounts
 *   pnpm hedera:check-accounts -- --save-evidence
 *
 * Payer checks: account exists and is not deleted; on-chain key type matches
 * HEDERA_PAYER_KEY_TYPE; the public key derived from HEDERA_PAYER_PRIVATE_KEY
 * equals the on-chain public key (proves the configured key controls the
 * account); balance is at least MIN_PAYER_HBAR.
 * Provider checks (if HEDERA_PROVIDER_ACCOUNTS is set): each account exists,
 * is not deleted, and is not the payer.
 */
import { loadEnv, parseLabelledAccounts, type LoadedEnv } from '../../packages/core/src/index.ts';
import {
  MirrorNodeClient,
  formatHbar,
  hashscanAccountUrl,
  parseHbar,
  type MirrorAccount,
} from '../../packages/hedera/src/index.ts';
import { parsePrivateKey, publicKeyHex, type KeyType } from '../../packages/hedera/src/sdk.ts';
import { handleScriptErrors, hasFlag, loadLocalEnvSource, writeEvidence } from '../lib/cli.ts';

handleScriptErrors();

const MIN_PAYER_HBAR = '5';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface AccountReport {
  readonly role: string;
  readonly accountId: string;
  readonly hashscan: string;
  readonly balanceHbar: string | null;
  readonly keyType: string | null;
  readonly maxAutomaticTokenAssociations: number | null;
  readonly checks: Check[];
}

const source = loadLocalEnvSource();
const env: LoadedEnv = loadEnv(['core', 'hedera'], source);
const providersRaw = source['HEDERA_PROVIDER_ACCOUNTS']?.trim() ?? '';
const providerEnv: LoadedEnv | null =
  providersRaw === '' ? null : loadEnv(['hedera', 'hedera-providers'], source);

const network = env.require('HEDERA_NETWORK') as 'testnet' | 'mainnet';
const mirror = new MirrorNodeClient(env.require('HEDERA_MIRROR_NODE_URL'));

function summarize(
  role: string,
  accountId: string,
  account: MirrorAccount | null,
  checks: Check[],
): AccountReport {
  return {
    role,
    accountId,
    hashscan: hashscanAccountUrl(network, accountId),
    balanceHbar: account === null ? null : formatHbar(account.balanceTinybars),
    keyType: account?.keyType ?? null,
    maxAutomaticTokenAssociations: account?.maxAutomaticTokenAssociations ?? null,
    checks,
  };
}

async function fetchAccount(accountId: string, checks: Check[]): Promise<MirrorAccount | null> {
  try {
    const account = await mirror.getAccount(accountId);
    checks.push({ name: 'exists on Mirror Node', ok: true, detail: account.accountId });
    checks.push({
      name: 'not deleted',
      ok: !account.deleted,
      detail: account.deleted ? 'DELETED' : 'active',
    });
    return account;
  } catch (error) {
    checks.push({
      name: 'exists on Mirror Node',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function checkPayer(): Promise<AccountReport> {
  const accountId = env.require('HEDERA_PAYER_ACCOUNT_ID');
  const keyType = env.require('HEDERA_PAYER_KEY_TYPE') as KeyType;
  const checks: Check[] = [];
  const account = await fetchAccount(accountId, checks);
  if (account !== null) {
    const expectedType = keyType === 'ecdsa' ? 'ECDSA_SECP256K1' : 'ED25519';
    checks.push({
      name: 'key type matches HEDERA_PAYER_KEY_TYPE',
      ok: account.keyType === expectedType,
      detail: `on-chain ${account.keyType ?? 'unknown/complex'}, configured ${expectedType}`,
    });

    let derived: string | null = null;
    try {
      derived = publicKeyHex(parsePrivateKey(env.require('HEDERA_PAYER_PRIVATE_KEY'), keyType));
    } catch (error) {
      checks.push({
        name: 'private key parses',
        ok: false,
        detail: error instanceof Error ? error.message : 'unparseable key',
      });
    }
    if (derived !== null) {
      checks.push({
        name: 'configured private key controls this account',
        ok: account.publicKey !== null && account.publicKey === derived,
        detail:
          account.publicKey === null
            ? 'on-chain key is not a single public key'
            : account.publicKey === derived
              ? 'derived public key matches on-chain key'
              : 'derived public key does NOT match on-chain key',
      });
    }

    const min = parseHbar(MIN_PAYER_HBAR);
    checks.push({
      name: `balance >= ${MIN_PAYER_HBAR} HBAR`,
      ok: account.balanceTinybars >= min,
      detail: `${formatHbar(account.balanceTinybars)} HBAR`,
    });
  }
  return summarize('payer', accountId, account, checks);
}

async function checkProvider(
  label: string,
  accountId: string,
  payerId: string,
): Promise<AccountReport> {
  const checks: Check[] = [];
  checks.push({ name: 'is not the payer', ok: accountId !== payerId, detail: accountId });
  const account = await fetchAccount(accountId, checks);
  return summarize(`provider:${label}`, accountId, account, checks);
}

const payerId = env.require('HEDERA_PAYER_ACCOUNT_ID');
const reports: AccountReport[] = [await checkPayer()];

if (providerEnv !== null) {
  const parsed = parseLabelledAccounts(providerEnv.require('HEDERA_PROVIDER_ACCOUNTS'));
  if (typeof parsed !== 'string') {
    for (const p of parsed) reports.push(await checkProvider(p.label, p.accountId, payerId));
  }
}

console.log(`Hedera account check on ${network} via ${mirror.baseUrl}\n`);
for (const r of reports) {
  console.log(`${r.role}  ${r.accountId}  balance: ${r.balanceHbar ?? 'n/a'} HBAR  ${r.hashscan}`);
  for (const c of r.checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
}
if (providerEnv === null) {
  console.log(
    '\nHEDERA_PROVIDER_ACCOUNTS is not set; create providers with `pnpm hedera:create-providers`.',
  );
}

const allOk = reports.every((r) => r.checks.every((c) => c.ok));

if (hasFlag('--save-evidence')) {
  const path = writeEvidence('hedera', 'accounts', {
    kind: 'hedera-account-check',
    checkedAt: new Date().toISOString(),
    network,
    mirrorNode: mirror.baseUrl,
    allOk,
    accounts: reports,
  });
  console.log(`\nEvidence written to ${path}`);
}

console.log(allOk ? '\nAll account checks passed.' : '\nSome account checks FAILED.');
process.exitCode = allOk ? 0 : 1;
