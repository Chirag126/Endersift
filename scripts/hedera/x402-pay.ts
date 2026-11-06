/**
 * Autonomous x402 payment: request a protected route, pay it from the payer
 * account with no human approval, and verify settlement on the Mirror Node.
 *
 *   pnpm x402:pay                                   pays http://127.0.0.1:<PROVIDERS_PORT>/v1/<first provider>/ping
 *   pnpm x402:pay -- --url http://127.0.0.1:4021/v1/kev/ping
 *   pnpm x402:pay -- --save-evidence
 *   pnpm x402:pay -- --max-tinybars 1000            negative check: cap below price → refused before signing
 *   pnpm x402:pay -- --url "http://127.0.0.1:4021/v1/kev/recent?since=2026-10-01" --save-evidence
 *                                                   paid threat-intel route: the body is also checked
 *                                                   against the zod IntelResponse schema
 *   pnpm x402:pay -- --usdc --url https://threat-intel-providers.onrender.com/v1/kev/ping-usdc --save-evidence
 *                                                   the USDC lane (plan row 37, D-064): pays in Circle
 *                                                   USDC (HTS) and verifies the token transfer; cap
 *                                                   --max-atomic (default 100000 = 0.1 USDC)
 *
 * Exit 0 only when the Mirror Node shows the exact transaction with result
 * SUCCESS, the payee credited exactly the quoted amount and the payer debited
 * exactly that amount. HTTP 200 alone is never treated as success.
 */
import { loadEnv, parseLabelledAccounts } from '../../packages/core/src/index.ts';
import {
  MirrorNodeClient,
  USDC_TOKEN_ID,
  formatHbar,
  formatUsdc,
  hashscanTransactionUrl,
  toMirrorTransactionId,
  verifyHbarSettlement,
  verifyTokenSettlement,
  type SettlementVerdict,
} from '../../packages/hedera/src/index.ts';
import { IntelResponse } from '../../packages/core/src/domain/index.ts';
import type { KeyType } from '../../packages/hedera/src/sdk.ts';
import {
  HBAR_ASSET,
  createGuardedHederaClient,
  pingPath,
  type HederaCaip2,
} from '../../packages/hedera/src/x402.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const source = loadLocalEnvSource();
const env = loadEnv(['hedera', 'providers'], source); // payer + x402 + providers (+ network)
const network = env.require('X402_NETWORK') as HederaCaip2;
const hederaNetwork = env.require('HEDERA_NETWORK') as 'testnet' | 'mainnet';
const payer = env.require('HEDERA_PAYER_ACCOUNT_ID');
const providers = parseLabelledAccounts(env.require('HEDERA_PROVIDER_ACCOUNTS'));
if (typeof providers === 'string' || providers[0] === undefined) {
  throw new Error('HEDERA_PROVIDER_ACCOUNTS must list at least one provider');
}

// --usdc: the USDC lane (D-064). Otherwise HBAR, as configured.
const usdc = hasFlag('--usdc');
const asset = usdc
  ? network === 'hedera:mainnet'
    ? USDC_TOKEN_ID.mainnet
    : USDC_TOKEN_ID.testnet
  : env.require('X402_ASSET');
if (!usdc && asset !== HBAR_ASSET)
  throw new Error('HBAR settlement expects X402_ASSET=0.0.0; use --usdc for the USDC lane');
const url =
  argValue('--url') ??
  `http://127.0.0.1:${env.require('PROVIDERS_PORT')}${pingPath(providers[0].label)}${usdc ? '-usdc' : ''}`;
const maxAtomic = BigInt(
  usdc
    ? (argValue('--max-atomic') ?? '100000')
    : (argValue('--max-tinybars') ?? env.require('X402_MAX_PAYMENT_TINYBARS')),
);
const unit = (atomic: bigint) =>
  usdc
    ? `${atomic} atomic (${formatUsdc(atomic)} USDC)`
    : `${atomic} tinybars (${formatHbar(atomic)} HBAR)`;

const guarded = createGuardedHederaClient({
  accountId: payer,
  privateKey: env.require('HEDERA_PAYER_PRIVATE_KEY'),
  keyType: env.require('HEDERA_PAYER_KEY_TYPE') as KeyType,
  network,
  policy: {
    network,
    asset,
    maxAmount: maxAtomic,
    allowedPayTo: providers.map((p) => p.accountId),
    payer,
  },
});
const mirror = new MirrorNodeClient(env.require('HEDERA_MIRROR_NODE_URL'));
const startedAt = new Date().toISOString();

console.log(`x402 payment run on ${network}`);
console.log(`  payer        ${payer}`);
console.log(`  url          ${url}`);
console.log(`  asset        ${asset}${usdc ? ' (Circle USDC, HTS)' : ' (HBAR)'}`);
console.log(`  cap          ${unit(maxAtomic)}`);
console.log(`  allowed payTo ${providers.map((p) => `${p.label}:${p.accountId}`).join(', ')}\n`);

let httpStatus: number | null = null;
let responseBody: unknown = null;
let requestError: string | null = null;
try {
  const response = await guarded.fetchWithPayment(url, { method: 'GET' });
  httpStatus = response.status;
  const text = await response.text();
  try {
    responseBody = JSON.parse(text);
  } catch {
    responseBody = text.slice(0, 500);
  }
} catch (error) {
  requestError = error instanceof Error ? error.message : String(error);
}

// Threat-intel routes (plan row 15): validate the paid body against the shared schema.
const looksLikeIntel =
  typeof responseBody === 'object' &&
  responseBody !== null &&
  'items' in responseBody &&
  'provider' in responseBody;
const intel = looksLikeIntel ? IntelResponse.safeParse(responseBody) : null;
const intelSummary =
  intel === null
    ? null
    : intel.success
      ? {
          schemaValid: true as const,
          provider: intel.data.provider,
          operation: intel.data.operation,
          source: intel.data.source.name,
          sourceFetchedAt: intel.data.source.fetchedAt,
          count: intel.data.count,
          truncated: intel.data.truncated,
          notFound: intel.data.notFound,
          ids: intel.data.items.map((i) => i.id),
        }
      : {
          schemaValid: false as const,
          issues: intel.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        };
/** Evidence keeps the first 3 items in full; ids of all items are in intelSummary. */
const evidenceBody =
  intel?.success === true
    ? {
        ...intel.data,
        items: intel.data.items.slice(0, 3),
        itemsOmitted: Math.max(0, intel.data.items.length - 3),
      }
    : responseBody;

const { record } = guarded;
const req = record.requirements;
if (req !== undefined) {
  console.log(
    `quote        ${unit(BigInt(req.amount))} of ${req.asset} to ${req.payTo} on ${req.network}, fee payer ${String(req.extra['feePayer'])}`,
  );
}
if (record.guard !== undefined) {
  console.log(
    record.guard.ok
      ? 'guard        ALLOWED'
      : `guard        REFUSED ${record.guard.code}: ${record.guard.reason}`,
  );
}
if (record.transactionId !== undefined)
  console.log(`tx id        ${record.transactionId} (known before submission)`);
if (record.settle !== undefined) {
  console.log(
    `facilitator  success=${record.settle.success} transaction=${record.settle.transaction}`,
  );
}
if (record.settleError !== undefined) console.log(`facilitator  error: ${record.settleError}`);
if (httpStatus !== null) console.log(`http         ${httpStatus}`);
if (requestError !== null) console.log(`request      failed: ${requestError}`);
if (intelSummary !== null) {
  console.log(
    intelSummary.schemaValid
      ? `intel        ${intelSummary.count} item(s) from ${intelSummary.source} · schema valid${intelSummary.truncated ? ' · truncated' : ''}${intelSummary.notFound.length > 0 ? ` · not found: ${intelSummary.notFound.join(', ')}` : ''}`
      : `intel        SCHEMA INVALID: ${intelSummary.issues.join('; ')}`,
  );
}

// Independent verification: the Mirror Node is the source of truth.
let verdict: SettlementVerdict | null = null;
let mirrorTxId: string | null = null;
const txId = record.transactionId ?? record.settle?.transaction;
if (txId !== undefined && req !== undefined && record.guard?.ok === true) {
  mirrorTxId = toMirrorTransactionId(txId);
  console.log(`\nverifying ${mirrorTxId} on ${mirror.baseUrl} ...`);
  const tx = await mirror.waitForTransaction(mirrorTxId, { timeoutMs: 45_000 });
  if (tx === null) {
    console.log(
      'NOT FOUND on the Mirror Node within 45s. The outcome is UNKNOWN: do not retry the payment;',
    );
    console.log(`re-check later at ${hashscanTransactionUrl(hederaNetwork, txId)}`);
  } else {
    const expected = { transactionId: txId, payer, payTo: req.payTo, amount: BigInt(req.amount) };
    verdict = usdc
      ? verifyTokenSettlement(tx, { ...expected, tokenId: asset })
      : verifyHbarSettlement(tx, expected);
    for (const c of verdict.checks)
      console.log(`  ${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
    console.log(`  consensus    ${tx.consensusTimestamp}`);
  }
}

// the quote must be in the asset this run was set up for (the guard checks it too)
const settled = verdict?.ok === true && intelSummary?.schemaValid !== false && req?.asset === asset;
const hashscan = txId === undefined ? null : hashscanTransactionUrl(hederaNetwork, txId);
if (hashscan !== null) console.log(`\nHashScan: ${hashscan}`);

if (hasFlag('--save-evidence')) {
  const name = `x402-${usdc ? 'usdc-' : ''}${settled ? 'settlement' : 'attempt'}`;
  const path = writeEvidence('hedera', name, {
    kind: usdc ? 'x402-payment-usdc' : 'x402-payment',
    asset,
    startedAt,
    finishedAt: new Date().toISOString(),
    network,
    url,
    payer,
    ...(usdc ? { capAtomic: maxAtomic } : { capTinybars: maxAtomic }),
    requirements: req ?? null,
    guard: record.guard ?? null,
    transactionId: txId ?? null,
    mirrorTransactionId: mirrorTxId,
    facilitatorSettle: record.settle ?? null,
    facilitatorError: record.settleError ?? null,
    httpStatus,
    responseBody: evidenceBody,
    intelSummary,
    requestError,
    mirrorVerification: verdict,
    settledAndVerified: settled,
    hashscan,
  });
  console.log(`Evidence written to ${path}`);
}

if (settled) {
  console.log('\nSETTLED AND VERIFIED: the Mirror Node confirms the exact payment.');
} else if (record.transactionId === undefined && record.settle === undefined) {
  // No payload was ever signed (afterPaymentCreation never fired): refused by
  // our guard, by x402 spend controls (which run first), or before payment.
  const by =
    record.guard !== undefined && !record.guard.ok
      ? `payment guard (${record.guard.code})`
      : (requestError ?? 'request did not reach payment');
  console.log(`\nNO PAYMENT MADE: refused before signing by ${by}. No transaction was created.`);
  process.exitCode = 1;
} else {
  console.log('\nNOT VERIFIED: see the lines above.');
  process.exitCode = 1;
}
