/**
 * LIVE end-to-end agent run (plan row 25): the orchestrator on real ENSv2
 * (Sepolia), real 0G inference and real x402 payments settled on Hedera.
 *
 *   pnpm providers:start                                                    (terminal 1)
 *   pnpm agent:run "OpenSSL, lodash@4.17.20 (npm)" --budget 300000 --allow-local-http --save-evidence
 *
 * Arguments:
 *   "<watchlist>"          comma-separated items (1-20), e.g. products, packages, vendors
 *   --budget <tinybars>    this run's budget; may only LOWER X402_RUN_BUDGET_TINYBARS
 *   --allow-local-http     accept the local provider service (http://127.0.0.1) found on ENS;
 *                          development only (D-035, D-045)
 *   --from-block <n>       start the ENS log scan here instead of searching for the
 *                          subregistry's deployment block (11999808 on Sepolia, see
 *                          docs/evidence/ens/discovery-20261026T205745Z.json)
 *   --max-purchases <n>    default 3 (never above X402_MAX_PAYMENTS_PER_RUN)
 *   --plan-tokens <n>      default 768;  --analyze-tokens <n>  default 1024
 *   --save-evidence        write docs/evidence/e2e/agent-run-*.json
 *
 * What is real: ENS discovery at one pinned block, the provider catalogs, both
 * 0G calls (through the inference ledger and its caps), the firewall on live
 * 402 quotes, the Hedera signatures, the paid requests, the Mirror Node
 * verification. Every step lands in DATABASE_PATH as run events, payments and
 * ledger rows. Exit 0 only if every evidence check below passes.
 */
import { dirname, join } from 'node:path';
import { loadEnv } from '../packages/core/src/index.ts';
import { formatZg, utcDay } from '../packages/zg/src/index.ts';
import { openDatabase } from '../apps/server/src/db/database.ts';
import { getRun, listRunEvents } from '../apps/server/src/db/repositories.ts';
import { runPolicy } from '../apps/server/src/orchestrator/orchestrator.ts';
import { LIVE_ENV_GROUPS, createLiveAgent } from '../apps/server/src/wiring.ts';
import {
  UsageError,
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from './lib/cli.ts';
import { agentRunChecks, parseWatchlist } from './lib/agent-run.ts';

handleScriptErrors();

// ── arguments ──────────────────────────────────────────────────────────────
const VALUE_FLAGS = new Set([
  '--budget',
  '--from-block',
  '--max-purchases',
  '--plan-tokens',
  '--analyze-tokens',
]);
const args = process.argv.slice(2).filter((a) => a !== '--');
const positional = args.filter(
  (a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1] ?? ''),
);
if (positional.length !== 1)
  throw new UsageError(
    'usage: pnpm agent:run "<watchlist, comma-separated>" --budget <tinybars> [--allow-local-http] [--save-evidence]',
  );
const watchlist = parseWatchlist(positional[0] ?? '');
const int = (flag: string, fallback: number | null, max: number): number | null => {
  const v = argValue(flag);
  if (v === undefined) return fallback;
  if (!/^\d{1,12}$/.test(v) || Number(v) < 1 || Number(v) > max)
    throw new UsageError(`${flag} must be an integer from 1 to ${max}`);
  return Number(v);
};
const budgetArg = argValue('--budget');
if (budgetArg === undefined || !/^[1-9]\d{0,15}$/.test(budgetArg))
  throw new UsageError('--budget <tinybars> is required (a positive integer, e.g. 300000)');
const fromBlock = int('--from-block', null, 1_000_000_000);
const maxPurchasesArg = int('--max-purchases', 3, 10) ?? 3;
const planTokens = int('--plan-tokens', 768, 4096) ?? 768;
const analyzeTokens = int('--analyze-tokens', 1024, 4096) ?? 1024;
const allowLocalHttp = hasFlag('--allow-local-http');

// ── configuration and wiring (apps/server/src/wiring.ts, shared with the API) ──
const env = loadEnv([...LIVE_ENV_GROUPS], loadLocalEnvSource());
const startedAt = new Date().toISOString();
const { db, migration } = openDatabase(env.require('DATABASE_PATH'));
const databasePath = env.require('DATABASE_PATH');
const agent = await createLiveAgent(env, db, {
  allowLocalHttp,
  logCachePath:
    databasePath === ':memory:' ? null : join(dirname(databasePath), 'ens-log-cache.json'),
  fromBlock: fromBlock === null ? null : BigInt(fromBlock),
  maxPurchases: maxPurchasesArg,
  planTokens,
  analyzeTokens,
});
const budget = BigInt(budgetArg);
// the policy in force: the owner's saved version (UI) under the env ceiling (D-052)
const inForce = agent.policyStore.effective();
if (inForce.policy.paymentsPaused === true)
  throw new UsageError(
    `payments are paused by the owner (policy version ${inForce.version}); resume them under Spending rules in the web app first`,
  );
const policy = (() => {
  try {
    return runPolicy(inForce.policy, budget);
  } catch (error) {
    throw new UsageError(
      `--budget ${budget}: ${error instanceof Error ? error.message : String(error)}; it may only lower the run budget in force (${inForce.source === 'env' ? 'X402_RUN_BUDGET_TINYBARS' : `owner policy v${inForce.version}`})`,
    );
  }
})();
const { orchestrator, store, ledger, hashscan, network, hederaNetwork } = agent;
const zg = agent.zg;
if (zg.unavailable !== null)
  throw new UsageError(`0G inference is unavailable: ${zg.unavailable}; see pnpm zg:models`);
const spent = await ledger.spentOnDay(utcDay(startedAt));

console.log(`LIVE agent run: Sepolia ENS + 0G ${zg.network} + Hedera ${hederaNetwork}`);
console.log(`  watchlist    ${watchlist.join(' · ')}`);
console.log(
  `  budget       run ${policy.maxPerRun} · per payment ${policy.maxPerPayment} · day ${policy.maxPerDay} tinybars · payer ${policy.payer}`,
);
console.log(
  `  0G           ${zg.modelId} · per-call cap ${formatZg(zg.capNeuron)} 0G · daily cap ${formatZg(zg.dailyCapNeuron)} 0G · spent today ${formatZg(spent.spent)} 0G`,
);
console.log(
  `               plan ≤${zg.limits.planMaxTokens} tokens · analysis ≤${zg.limits.analyzeMaxTokens} tokens with a prompt of ≤${String(zg.limits.analyzePromptTokens)} tokens`,
);
console.log(
  `  ENS          discovered inside the run${fromBlock === null ? ' (ENS_DISCOVERY_FROM_BLOCK if set, else searching the deployment block; --from-block overrides)' : ` from block ${fromBlock}`}`,
);

const recovered = orchestrator.recoverInterrupted(30 * 60_000);
for (const r of recovered) console.log(`closed an interrupted run ${r.id} (${r.status})`);

// ── the run ────────────────────────────────────────────────────────────────
console.log('\nrunning: catalogs → 0G plan → firewall → pay → Mirror Node → 0G analysis → brief\n');
const { run, report } = await orchestrator.run(
  { trigger: 'manual', watchlist },
  { budget, origin: 'cli' },
);
const snapshot = agent.lastSnapshot();
if (snapshot !== null) {
  console.log(
    `ENS block ${snapshot.blockNumber}: ${snapshot.providers.map((p) => `${p.provider.ensName} (${p.provider.priceAtomic} → ${p.provider.payTo})`).join(', ') || 'none'}`,
  );
  for (const sk of snapshot.skipped) console.log(`  skipped ${sk.label}: ${sk.code}`);
}
const discovered = listRunEvents(db, run.id).find((e) => e.type === 'PROVIDERS_DISCOVERED');
const observedAt =
  typeof discovered?.payload['observedAt'] === 'string' ? discovered.payload['observedAt'] : null;

const events = listRunEvents(db, run.id);
for (const e of events) {
  const p = e.payload;
  const detail = [
    p['provider'],
    p['purpose'],
    p['status'],
    p['code'],
    p['transactionId'],
    p['requestId'],
    p['count'] === undefined ? undefined : `${String(p['count'])} items`,
  ]
    .filter((x) => x !== undefined && x !== null)
    .map(String)
    .join(' · ');
  console.log(
    `${String(e.seq).padStart(2)}  ${e.at.slice(11, 19)}  ${e.type.padEnd(20)} ${detail}`,
  );
}

const payments = await store.listByRun(run.id);
const calls = await ledger.listCalls({ runId: run.id });
const paymentDetails = await Promise.all(
  payments.map(async (p) => ({
    ...p,
    history: await store.history(p.id),
    verifications: await store.verifications(p.id),
    hashscan: p.transactionId === null ? null : hashscan(p.transactionId),
  })),
);
const finalRun = getRun(db, run.id) ?? run;
const checks = agentRunChecks({
  run: finalRun,
  events,
  payments: paymentDetails,
  calls,
  report,
  ensBlock: snapshot?.blockNumber ?? -1n,
});

console.log('\nchecks');
for (const c of checks.list)
  console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.detail === '' ? '' : ` (${c.detail})`}`);
for (const p of paymentDetails)
  if (p.hashscan !== null) console.log(`  HashScan ${p.provider.padEnd(20)} ${p.hashscan}`);
console.log(
  `\nrun ${finalRun.status}${finalRun.error === null ? '' : ` · ${finalRun.error}`} · ${run.id}`,
);
if (report !== null) console.log(`\n${report}`);

if (hasFlag('--save-evidence')) {
  const path = writeEvidence('e2e', checks.verified ? 'agent-run' : 'agent-run-attempt', {
    kind: 'agent-run-live',
    startedAt,
    finishedAt: new Date().toISOString(),
    networks: { ens: 'sepolia', hedera: network, zg: zg.network },
    database: { migration: migration.current },
    input: { watchlist, budget: budget.toString(), allowLocalHttp, maxPurchases: maxPurchasesArg },
    policy,
    zg: {
      model: zg.modelId,
      capNeuron: zg.capNeuron,
      dailyCapNeuron: zg.dailyCapNeuron,
      planTokens: zg.limits.planMaxTokens,
      analyzeTokens: zg.limits.analyzeMaxTokens,
      analyzePromptTokens: zg.limits.analyzePromptTokens,
      spentTodayBefore: spent.spent,
    },
    ens:
      snapshot === null
        ? null
        : {
            parent: snapshot.parent,
            subregistry: snapshot.subregistry,
            blockNumber: snapshot.blockNumber,
            blockHash: snapshot.blockHash,
            fromBlock: snapshot.fromBlock,
            observedAt,
            providers: snapshot.providers.map((p) => p.provider),
            skipped: snapshot.skipped,
          },
    run: finalRun,
    events,
    payments: paymentDetails,
    inference: calls,
    report,
    checks: checks.list,
    verified: checks.verified,
  });
  console.log(`\nEvidence written to ${path}`);
}
console.log(
  checks.verified
    ? `\nLIVE END-TO-END RUN VERIFIED: ENS block ${snapshot?.blockNumber ?? '-'}, ${checks.settled} payment(s) settled and verified on the Mirror Node, 0G plan and analysis recorded, brief written.`
    : '\nNOT VERIFIED: see the FAIL lines above (everything that happened is in the database and the events).',
);
db.close();
if (!checks.verified) process.exitCode = 1;
