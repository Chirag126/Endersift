/**
 * Read the guard contract: caps, balance, registry, blocklist and the latest receipts.
 *
 *   pnpm near:status
 *   pnpm near:status -- --save-evidence
 *
 * Read-only: needs NEAR_NODE_URL and NEAR_GUARD_CONTRACT_ID, no key.
 */
import { handleScriptErrors, hasFlag, loadLocalEnvSource, writeEvidence } from '../lib/cli.ts';
import { explorerAccount, near, nearContext } from './lib.ts';

handleScriptErrors();

const { network, rpc, guard } = nearContext(loadLocalEnvSource());
const [status, providers, head] = await Promise.all([
  guard.status(),
  guard.providers(),
  rpc.head(),
]);
const from = Math.max(0, status.receipts - 10);
const receipts = await guard.receipts(from, 10);
const reports = await Promise.all(
  providers
    .filter((p) => p.blocked)
    .map(async (p) => [p.accountId, await guard.reports(p.accountId)] as const),
);

console.log(`Endersift guard ${guard.contractId} on ${network} (block ${head.height})`);
console.log(`  ${explorerAccount(network, guard.contractId)}\n`);
console.log(`  owner            ${status.owner}`);
console.log(`  agent            ${status.agent}`);
console.log(`  paused           ${status.paused ? 'YES' : 'no'}`);
console.log(`  balance          ${near(status.balance)}`);
console.log(`  cap per payment  ${near(status.policy.maxPerPayment)}`);
console.log(
  `  cap per run      ${near(status.policy.maxPerRun)} in at most ${status.policy.maxPaymentsPerRun} payments`,
);
console.log(
  `  cap per day      ${near(status.policy.maxPerDay)} (spent today: ${near(status.spentToday)})`,
);

console.log(`\n  providers (${providers.length}):`);
for (const p of providers)
  console.log(
    `    ${p.label.padEnd(5)} ${p.accountId.padEnd(34)} ${near(p.price).padEnd(12)} ${p.blocked ? 'BLOCKED' : 'ok     '} ${p.endpoint}`,
  );
for (const [accountId, list] of reports)
  for (const r of list)
    console.log(
      `    report on ${accountId} by ${r.reporter}: ${r.reason} (evidence: ${r.evidence})`,
    );

console.log(`\n  receipts ${from}-${Math.max(from, status.receipts - 1)} of ${status.receipts}:`);
for (const r of receipts)
  console.log(
    `    #${String(r.id).padEnd(4)} ${r.status.padEnd(7)} ${near(r.amount).padEnd(12)} → ${r.receiver.padEnd(34)} run ${r.runId} · work ${r.passed === null ? 'not checked' : r.passed ? 'passed' : 'FAILED'}`,
  );

if (hasFlag('--save-evidence')) {
  const path = writeEvidence('near', 'guard-status', {
    kind: 'near-guard-status',
    readAt: new Date().toISOString(),
    network,
    blockHeight: head.height,
    guard: guard.contractId,
    status,
    providers,
    reports: Object.fromEntries(reports),
    receipts,
  });
  console.log(`\nEvidence written to ${path}`);
}
