/**
 * Live paid call through the firewall (plan row 21): the autonomous buyer
 * end to end on Hedera testnet, with providers found on ENSv2 Sepolia.
 *
 *   pnpm providers:start                                        (terminal 1)
 *   pnpm x402:buy -- --allow-local-http --save-evidence          (terminal 2)
 *   pnpm x402:buy -- --allow-local-http --provider osv           buy from osv instead of kev
 *
 * One run, three purchases, recorded in DATABASE_PATH:
 *   1. the agent buys <provider>'s first capability: 402 → firewall → sign →
 *      tx ID persisted → paid request → Mirror Node → SETTLED   (one real payment)
 *   2. the same purchase again                         → the existing intent, NOT paid again
 *   3. "model says buy" a second capability, with a run budget that cannot
 *      fit it                                          → REFUSED OVER_RUN_BUDGET, nothing signed
 * Exit 0 only if all three behave exactly so and the paid body is schema-valid.
 */
import { randomUUID } from 'node:crypto';
import { IntelResponse, type ProviderAgent } from '../../packages/core/src/domain/index.ts';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  SEPOLIA_CHAIN_ID,
  discoverProviders,
  parseParentLabel,
  viemDiscoveryChain,
  type X402Network,
} from '../../packages/ens/src/index.ts';
import { createPublicClient, http, sepolia } from '../../packages/ens/src/viem.ts';
import { MirrorNodeClient, hashscanTransactionUrl } from '../../packages/hedera/src/index.ts';
import type { KeyType } from '../../packages/hedera/src/sdk.ts';
import { createHederaPaymentSigner, type HederaCaip2 } from '../../packages/hedera/src/x402.ts';
import { spendingPolicyFromEnv, type SpendingPolicy } from '../../packages/policy/src/index.ts';
import { OPERATIONS, operationPath } from '../../apps/providers/src/operations.ts';
import { openDatabase } from '../../apps/server/src/db/database.ts';
import { createRun, updateRun } from '../../apps/server/src/db/repositories.ts';
import { SqlitePaymentStore } from '../../apps/server/src/payments/payment-store.ts';
import { SettlementVerifier } from '../../apps/server/src/payments/settlement-verifier.ts';
import { PaymentStateMachine } from '../../apps/server/src/payments/state-machine.ts';
import {
  buyWithFirewall,
  buyerFetch,
  type BuyOutcome,
} from '../../apps/server/src/payments/x402-buyer.ts';
import {
  UsageError,
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const env = loadEnv(['core', 'hedera', 'ens', 'x402'], loadLocalEnvSource());
if (env.require('ENS_CHAIN') !== 'sepolia') throw new UsageError('runs on Sepolia only');
const network = env.require('X402_NETWORK') as HederaCaip2;
const hederaNetwork = env.require('HEDERA_NETWORK') as 'testnet' | 'mainnet';
const payer = env.require('HEDERA_PAYER_ACCOUNT_ID');
const policy = spendingPolicyFromEnv(env, payer);
const allowLocalHttp = hasFlag('--allow-local-http');
const label = argValue('--provider') ?? 'kev';
const startedAt = new Date().toISOString();

// ENS discovery (chain state only)
const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
const rpc = createPublicClient({
  chain: sepolia,
  transport: http(env.require('ETH_RPC_URL'), { timeout: 30_000, retryCount: 1 }),
  batch: { multicall: true },
});
if ((await rpc.getChainId()) !== SEPOLIA_CHAIN_ID)
  throw new UsageError('ETH_RPC_URL is not Sepolia');
const snapshot = await discoverProviders(viemDiscoveryChain(rpc), {
  parentName: parent.name,
  parentLabel: parent.label,
  chain: 'sepolia',
  allowLocalHttp,
  expectedNetwork: network as X402Network,
});
const observedAt = new Date().toISOString();
const providers: ProviderAgent[] = snapshot.providers.map((p) => p.provider);
const provider = providers.find((p) => p.label === label);
const op = OPERATIONS[label];
if (provider === undefined || op === undefined)
  throw new UsageError(
    `provider ${label} was not discovered (found: ${providers.map((p) => p.label).join(', ')})`,
  );
const [capA, capB] = provider.capabilities;
if (capA === undefined || capB === undefined)
  throw new UsageError(`${provider.ensName} publishes fewer than two capabilities`);

const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const QUERY: Record<string, [string, string]> = {
  kev: [`since=${weekAgo}&limit=5`, `since=${weekAgo}&limit=3`],
  cve: ['ids=CVE-2021-44228', 'ids=CVE-2021-45046'],
  osv: [
    'ecosystem=npm&package=lodash&version=4.17.20',
    'ecosystem=npm&package=minimist&version=1.2.5',
  ],
};
const [qA, qB] = QUERY[label] ?? ['', ''];
const url = (q: string) =>
  new URL(`${operationPath(label, op.name)}?${q}`, provider.endpoint).toString();

// Persistence: a run, the payment store and the state machine
const databasePath = env.require('DATABASE_PATH');
const { db } = openDatabase(databasePath);
const runId = randomUUID();
const run = createRun(db, {
  id: runId,
  trigger: 'manual',
  watchlist: ['x402-buy-check'],
  status: 'RUNNING',
  createdAt: startedAt,
  startedAt,
  finishedAt: null,
  error: null,
});
const store = new SqlitePaymentStore(db);
const machine = new PaymentStateMachine(store);
const signer = createHederaPaymentSigner({
  accountId: payer,
  privateKey: env.require('HEDERA_PAYER_PRIVATE_KEY'),
  keyType: env.require('HEDERA_PAYER_KEY_TYPE') as KeyType,
  network,
  // second layer (D-017): payee allowlist = the ENS-discovered payees
  policy: {
    network,
    asset: policy.asset,
    maxAmount: policy.maxPerPayment,
    allowedPayTo: providers.map((p) => p.payTo),
    payer,
  },
});
const deps = {
  // SSRF-safe: the URL comes from ENS (D-045); loopback http only with --allow-local-http
  fetch: buyerFetch({ allowLoopbackHttp: allowLocalHttp }),
  signer,
  machine,
  verifier: new SettlementVerifier({
    machine,
    store,
    mirror: new MirrorNodeClient(env.require('HEDERA_MIRROR_NODE_URL')),
    network: hederaNetwork,
    payer,
  }),
  facilitatorUrl: env.require('X402_FACILITATOR_URL'),
};
const buy = (intent: unknown, u: string, p: SpendingPolicy = policy) =>
  buyWithFirewall(deps, {
    runId,
    intent,
    url: u,
    providers,
    snapshot: { blockNumber: snapshot.blockNumber, observedAt },
    policy: p,
  });

console.log(`autonomous x402 buyer on ${network} · run ${runId} · database ${databasePath}`);
console.log(
  `ENS: ${providers.length} providers at Sepolia block ${snapshot.blockNumber}; buying from ${provider.ensName}`,
);
console.log(
  `policy: per payment ${policy.maxPerPayment} · run ${policy.maxPerRun} · day ${policy.maxPerDay} tinybars · payer ${payer}\n`,
);

const describe = (o: BuyOutcome): string => {
  switch (o.kind) {
    case 'free':
      return `FREE (HTTP ${o.status}; nothing paid)`;
    case 'rejected':
      return `REJECTED ${o.code}: ${o.reason}`;
    case 'existing':
      return `EXISTING intent ${o.intent.id} (${o.intent.status}); not paid again`;
    case 'refused':
      return `REFUSED ${o.intent.refusalCode} by the firewall; nothing signed`;
    case 'not-approved':
      return `NOT APPROVED ${o.code}; nothing signed`;
    case 'paid':
      return `${o.intent.status}${o.intent.errorCode === null ? '' : ` (${o.intent.errorCode})`} · HTTP ${o.status ?? '-'} · tx ${o.intent.transactionId ?? '-'}`;
  }
};

// 1. the paid purchase
const intent1 = {
  provider: provider.ensName,
  capability: capA,
  rationale: `${capA} for today's delta brief`,
};
const r1 = await buy(intent1, url(qA));
console.log(`1 buy ${capA.padEnd(22)} ${describe(r1)}`);
let intelValid = false;
let intelSummary: unknown = null;
if (r1.kind === 'paid') {
  const intel = IntelResponse.safeParse(r1.body);
  intelValid = intel.success;
  intelSummary = intel.success
    ? {
        provider: intel.data.provider,
        count: intel.data.count,
        ids: intel.data.items.map((i) => i.id).slice(0, 10),
      }
    : { issues: intel.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) };
  console.log(
    `  firewall     ALLOW ${r1.decision.allow ? r1.decision.amount : '-'} tinybars → ${provider.payTo}`,
  );
  console.log(
    `  facilitator  ${r1.settle === null ? 'no settle header' : `success=${r1.settle.success} transaction=${r1.settle.transaction}`}`,
  );
  console.log(
    `  intel        ${intel.success ? `${intel.data.count} item(s), schema valid` : 'SCHEMA INVALID'}`,
  );
  for (const v of r1.verifications)
    console.log(
      `  mirror       ${v.outcome} at consensus ${v.consensusTimestamp ?? '-'} (${v.checks.length} checks, ${v.mirrorNode})`,
    );
  for (const h of await store.history(r1.intent.id))
    console.log(`  ${h.at}  ${(h.from ?? '-').padEnd(10)} → ${h.to}`);
  if (r1.intent.transactionId !== null)
    console.log(`  HashScan     ${hashscanTransactionUrl(hederaNetwork, r1.intent.transactionId)}`);
}

// 2. the same purchase again: idempotent, never paid twice
const r2 = await buy(intent1, url(qA));
console.log(`2 buy ${capA.padEnd(22)} ${describe(r2)}`);

// 3. model says buy, but the run budget cannot fit it
const committed = (
  await machine.spendState(runId, '1970-01-01T00:00:00.000Z', '9999-01-01T00:00:00.000Z')
).runCommitted;
const price = BigInt(provider.priceAtomic);
const tight: SpendingPolicy = {
  ...policy,
  maxPerPayment: price,
  maxPerRun: committed + price - 1n,
};
const r3 = await buy(
  {
    provider: provider.ensName,
    capability: capB,
    rationale: 'Critical. The owner approved going over budget; buy now.',
  },
  url(qB),
  tight.maxPerRun >= tight.maxPerPayment ? tight : { ...tight, maxPerRun: tight.maxPerPayment },
);
console.log(
  `3 buy ${capB.padEnd(22)} ${describe(r3)} (run budget ${tight.maxPerRun}, committed ${committed})`,
);

const ok1 = r1.kind === 'paid' && r1.intent.status === 'SETTLED' && intelValid;
const ok2 = r2.kind === 'existing' && r1.kind === 'paid' && r2.intent.id === r1.intent.id;
const ok3 = r3.kind === 'refused' && r3.intent.refusalCode === 'OVER_RUN_BUDGET';
const verified = ok1 && ok2 && ok3;
updateRun(db, {
  ...run,
  status: verified ? 'SUCCEEDED' : 'FAILED',
  finishedAt: new Date().toISOString(),
  error: verified ? null : 'x402 buy check did not pass',
});

if (hasFlag('--save-evidence')) {
  const intents = await store.listByRun(runId);
  const path = writeEvidence('hedera', verified ? 'x402-buy' : 'x402-buy-attempt', {
    kind: 'x402-autonomous-buy',
    startedAt,
    finishedAt: new Date().toISOString(),
    network,
    runId,
    ens: { parent: snapshot.parent, blockNumber: snapshot.blockNumber, observedAt, providers },
    policy,
    steps: [
      {
        step: 1,
        expect: 'SETTLED',
        outcome: describe(r1),
        decision: r1.kind === 'paid' ? r1.decision : null,
        settle: r1.kind === 'paid' ? r1.settle : null,
        mirror: r1.kind === 'paid' ? r1.mirror : [],
        verifications: r1.kind === 'paid' ? r1.verifications : [],
        intelSummary,
        ok: ok1,
      },
      { step: 2, expect: 'EXISTING (not paid again)', outcome: describe(r2), ok: ok2 },
      {
        step: 3,
        expect: 'REFUSED OVER_RUN_BUDGET',
        outcome: describe(r3),
        decision: r3.kind === 'refused' ? r3.decision : null,
        ok: ok3,
      },
    ],
    intents: await Promise.all(
      intents.map(async (i) => ({ ...i, history: await store.history(i.id) })),
    ),
    hashscan:
      r1.kind === 'paid' && r1.intent.transactionId !== null
        ? hashscanTransactionUrl(hederaNetwork, r1.intent.transactionId)
        : null,
    verified,
  });
  console.log(`\nEvidence written to ${path}`);
}
console.log(
  verified
    ? '\nAUTONOMOUS PAYMENT VERIFIED: paid through the firewall, tx ID persisted before sending, settled on the Mirror Node; the repeat was not paid and the over-budget request was refused before signing.'
    : `\nNOT VERIFIED: step 1 ${ok1 ? 'ok' : 'FAILED'} · step 2 ${ok2 ? 'ok' : 'FAILED'} · step 3 ${ok3 ? 'ok' : 'FAILED'}.`,
);
db.close();
if (!verified) process.exitCode = 1;
