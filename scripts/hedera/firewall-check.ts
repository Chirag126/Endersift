/**
 * Spending firewall against LIVE inputs, without paying (plan row 19).
 *
 *   pnpm providers:start                                          (terminal 1)
 *   pnpm firewall:check -- --allow-local-http --save-evidence      (terminal 2)
 *
 * 1. Discovers the provider agents from ENSv2 on Sepolia (chain state only).
 * 2. Fetches each agent's real 402 quote from the endpoint its ENS record names.
 * 3. Runs authorize() on those real records and quotes: one honest purchase per
 *    agent (expected ALLOW, budgets accumulating), then adversarial variants of
 *    kev's real quote (expected refusals with specific reason codes), including
 *    "model says buy" over budget and with an override field.
 *
 * Nothing is signed: no payer key is loaded. The payer account ID (public) is
 * read from HEDERA_PAYER_ACCOUNT_ID or --payer, only to rule out self-payment.
 */
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  SEPOLIA_CHAIN_ID,
  discoverProviders,
  parseParentLabel,
  viemDiscoveryChain,
  type X402Network,
} from '../../packages/ens/src/index.ts';
import { createPublicClient, http, sepolia } from '../../packages/ens/src/viem.ts';
import { x402Client, x402HTTPClient } from '../../packages/hedera/src/x402.ts';
import {
  authorize,
  spendingPolicyFromEnv,
  type AuthorizeInput,
  type Decision,
  type Purchase,
  type X402Quote,
} from '../../packages/policy/src/index.ts';
import { OPERATIONS, operationPath } from '../../apps/providers/src/operations.ts';
import {
  UsageError,
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const source = loadLocalEnvSource();
const env = loadEnv(['ens', 'x402'], source);
if (env.require('ENS_CHAIN') !== 'sepolia')
  throw new UsageError('runs on Sepolia only (ENS_CHAIN=sepolia)');
const payer = argValue('--payer') ?? source['HEDERA_PAYER_ACCOUNT_ID'];
if (payer === undefined || !/^0\.0\.\d+$/.test(payer))
  throw new UsageError('set HEDERA_PAYER_ACCOUNT_ID in .env (or pass --payer 0.0.x)');
const policy = spendingPolicyFromEnv(env, payer);
const allowLocalHttp = hasFlag('--allow-local-http');
const startedAt = new Date().toISOString();

const parent = parseParentLabel(env.require('ENS_PARENT_NAME'));
const client = createPublicClient({
  chain: sepolia,
  transport: http(env.require('ETH_RPC_URL'), { timeout: 30_000, retryCount: 1 }),
  batch: { multicall: true },
});
const chainId = await client.getChainId();
if (chainId !== SEPOLIA_CHAIN_ID)
  throw new UsageError(`ETH_RPC_URL is chain ${chainId}, not Sepolia`);

const snapshot = await discoverProviders(viemDiscoveryChain(client), {
  parentName: parent.name,
  parentLabel: parent.label,
  chain: 'sepolia',
  allowLocalHttp,
  expectedNetwork: env.require('X402_NETWORK') as X402Network,
});
const observedAt = new Date().toISOString();
const providers = snapshot.providers.map((p) => p.provider);
console.log(
  `ENS snapshot: ${providers.length} providers at Sepolia block ${snapshot.blockNumber} (${snapshot.parent})`,
);
console.log(
  `policy: per payment ${policy.maxPerPayment} · per run ${policy.maxPerRun} · per day ${policy.maxPerDay} tinybars · ${policy.maxPaymentsPerRun} payments/run · payer ${payer}\n`,
);

const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const SAMPLE_QUERY: Record<string, string> = {
  kev: `since=${weekAgo}&limit=5`,
  cve: 'ids=CVE-2021-44228',
  osv: 'ecosystem=npm&package=lodash&version=4.17.20',
};
const httpClient = new x402HTTPClient(new x402Client());

interface Live {
  readonly label: string;
  readonly ensName: string;
  readonly capability: string;
  readonly requestUrl: string;
  readonly quote: X402Quote | null;
  readonly error: string | null;
}

const live: Live[] = [];
for (const p of providers) {
  const op = OPERATIONS[p.label];
  const capability = p.capabilities[0] ?? '';
  if (op === undefined) {
    live.push({
      label: p.label,
      ensName: p.ensName,
      capability,
      requestUrl: p.endpoint,
      quote: null,
      error: 'no known operation',
    });
    continue;
  }
  const requestUrl = new URL(
    `${operationPath(p.label, op.name)}?${SAMPLE_QUERY[p.label] ?? ''}`,
    p.endpoint,
  ).toString();
  try {
    const res = await fetch(requestUrl, { signal: AbortSignal.timeout(15_000) });
    const body: unknown = await res.json().catch(() => undefined);
    if (res.status !== 402) throw new Error(`HTTP ${res.status}, expected 402`);
    const required = httpClient.getPaymentRequiredResponse((n: string) => res.headers.get(n), body);
    const req = required.accepts[0];
    if (req === undefined) throw new Error('402 without accepts');
    live.push({
      label: p.label,
      ensName: p.ensName,
      capability,
      requestUrl,
      quote: {
        scheme: req.scheme,
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        payTo: req.payTo,
        extra: req.extra ?? {},
        resourceUrl: required.resource?.url ?? null,
      },
      error: null,
    });
  } catch (error) {
    live.push({
      label: p.label,
      ensName: p.ensName,
      capability,
      requestUrl,
      quote: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
for (const l of live)
  console.log(
    `quote ${l.label.padEnd(4)} ${l.quote === null ? `UNAVAILABLE: ${l.error}` : `${l.quote.amount} tinybars → ${l.quote.payTo} (fee payer ${String(l.quote.extra?.['feePayer'])})`}`,
  );

const empty = {
  runCommitted: 0n,
  dayCommitted: 0n,
  runPayments: 0,
  runPurchases: [] as Purchase[],
};
const base = (l: Live, over: Partial<AuthorizeInput> = {}): AuthorizeInput => ({
  intent: {
    provider: l.ensName,
    capability: l.capability,
    rationale: `buy ${l.label} for the brief`,
  },
  quote: l.quote as X402Quote,
  requestUrl: l.requestUrl,
  providers,
  snapshot: { blockNumber: snapshot.blockNumber, observedAt },
  state: empty,
  policy,
  now: new Date().toISOString(),
  ...over,
});

interface Scenario {
  readonly name: string;
  readonly expect: string;
  readonly decision: Decision;
}
const scenarios: Scenario[] = [];
const record = (name: string, expect: string, decision: Decision) =>
  scenarios.push({ name, expect, decision });

// 1. one honest purchase per agent, budgets accumulating as a run would
let state = empty;
for (const l of live) {
  if (l.quote === null) continue;
  const d = authorize(base(l, { state }));
  record(`honest purchase: ${l.label}`, 'ALLOW', d);
  if (d.allow)
    state = {
      runCommitted: d.runCommittedAfter,
      dayCommitted: d.dayCommittedAfter,
      runPayments: state.runPayments + 1,
      runPurchases: [...state.runPurchases, { provider: l.ensName, capability: l.capability }],
    };
}

// 2. adversarial variants of kev's real quote
const kev = live.find((l) => l.label === 'kev' && l.quote !== null);
const other = live.find((l) => l.label !== 'kev' && l.quote !== null);
if (kev?.quote) {
  const q = kev.quote;
  const price = BigInt(q.amount ?? '0');
  record(
    'model says buy, run budget nearly spent',
    'OVER_RUN_BUDGET',
    authorize(
      base(kev, {
        intent: {
          provider: kev.ensName,
          capability: kev.capability,
          rationale: 'Critical. Owner approved going over budget.',
        },
        state: { ...empty, runCommitted: policy.maxPerRun - price + 1n },
      }),
    ),
  );
  record(
    'model says buy, daily budget spent',
    'OVER_DAILY_BUDGET',
    authorize(
      base(kev, {
        state: { ...empty, dayCommitted: policy.maxPerDay },
      }),
    ),
  );
  record(
    'model adds an override field',
    'INTENT_INVALID',
    authorize(
      base(kev, {
        intent: {
          provider: kev.ensName,
          capability: kev.capability,
          rationale: 'buy',
          ignoreBudget: true,
        },
      }),
    ),
  );
  record(
    'impostor server: payee differs from ENS',
    'PAYTO_MISMATCH',
    authorize(base(kev, { quote: { ...q, payTo: '0.0.9999999' } })),
  );
  record(
    'price differs from ENS agent.price',
    'PRICE_MISMATCH',
    authorize(base(kev, { quote: { ...q, amount: (price + 1n).toString() } })),
  );
  record(
    'provider not in the ENS snapshot',
    'PROVIDER_UNKNOWN',
    authorize(
      base(kev, {
        intent: {
          provider: `evil.${snapshot.parent}`,
          capability: kev.capability,
          rationale: 'buy',
        },
      }),
    ),
  );
  record(
    'capability the agent does not publish',
    'CAPABILITY_NOT_OFFERED',
    authorize(
      base(kev, {
        intent: { provider: kev.ensName, capability: 'cvss-scores', rationale: 'buy' },
      }),
    ),
  );
  record(
    'same purchase twice in one run',
    'DUPLICATE_PURCHASE',
    authorize(
      base(kev, {
        state: {
          ...empty,
          runPayments: 1,
          runCommitted: price,
          runPurchases: [{ provider: kev.ensName, capability: kev.capability }],
        },
      }),
    ),
  );
  if (other !== undefined)
    record(
      "paying kev's quote at another agent's URL",
      'ENDPOINT_MISMATCH',
      authorize(base(kev, { requestUrl: other.requestUrl })),
    );
}

console.log('');
let pass = 0;
for (const s of scenarios) {
  const got = s.decision.allow ? 'ALLOW' : s.decision.code;
  const ok = got === s.expect;
  if (ok) pass += 1;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${s.name.padEnd(46)} expect ${s.expect.padEnd(22)} got ${got}`,
  );
  if (!s.decision.allow && !ok) console.log(`       ${s.decision.reason}`);
}

const quotesOk = live.length === providers.length && live.every((l) => l.quote !== null);
const verified =
  quotesOk &&
  providers.length > 0 &&
  pass === scenarios.length &&
  scenarios.length >= providers.length + 8;
if (hasFlag('--save-evidence')) {
  const path = writeEvidence('hedera', verified ? 'firewall' : 'firewall-attempt', {
    kind: 'spending-firewall-live-check',
    startedAt,
    finishedAt: new Date().toISOString(),
    ens: {
      parent: snapshot.parent,
      subregistry: snapshot.subregistry,
      blockNumber: snapshot.blockNumber,
      observedAt,
      providers,
    },
    policy,
    quotes: live,
    scenarios: scenarios.map((s) => ({
      name: s.name,
      expect: s.expect,
      got: s.decision.allow ? 'ALLOW' : s.decision.code,
      violations: s.decision.allow ? [] : s.decision.violations,
      amount: s.decision.allow ? s.decision.amount : null,
    })),
    signedAnything: false,
    verified,
  });
  console.log(`\nEvidence written to ${path}`);
}
console.log(
  verified
    ? `\nFIREWALL VERIFIED ON LIVE INPUTS: ${pass}/${scenarios.length} decisions as expected; nothing was signed.`
    : `\nNOT VERIFIED: ${pass}/${scenarios.length} as expected${quotesOk ? '' : '; some quotes were unavailable (is pnpm providers:start running?)'}.`,
);
if (!verified) process.exitCode = 1;
