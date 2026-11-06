/**
 * One live 0G call through the inference ledger (plan row 18).
 *
 *   pnpm ledger:call                                one triage call, recorded in DATABASE_PATH
 *   pnpm ledger:call -- --max-tokens 768
 *   pnpm ledger:call -- --daily-cap 1000000000000000
 *        lower the daily cap for this run only (never above ZG_DAILY_CAP_NEURON),
 *        to see a DAILY_CAP_EXCEEDED refusal without editing .env
 *
 * Order (apps/server/src/inference/ledgered-call.ts): per-call cap → daily-cap
 * reservation (PENDING row) → one call, never retried → settle the row.
 * With ZG_MANAGEMENT_KEY set, a balance snapshot is stored before and after.
 * Exit 0 only for a SUCCEEDED row with schema-valid output naming exactly the
 * input advisories, or (with --daily-cap) for a correct DAILY_CAP_EXCEEDED refusal.
 */
import { utcDay } from '../../packages/zg/src/index.ts';
import { ledgeredStructuredCall } from '../../apps/server/src/inference/ledgered-call.ts';
import { takeBalanceSnapshot } from '../../apps/server/src/ledger/balance-job.ts';
import { UsageError, argValue, handleScriptErrors } from '../lib/cli.ts';
import { idsMatchInput, triageTask } from '../lib/triage-sample.ts';
import { callLine, ledgerSetup, snapshotLine, zg } from './shared.ts';

handleScriptErrors();

const s = ledgerSetup({ needManagementKey: false });
const maxTokensArg = argValue('--max-tokens');
if (maxTokensArg !== undefined && !/^\d{1,4}$/.test(maxTokensArg))
  throw new UsageError('--max-tokens must be 1-9999');
const maxTokens = Number(maxTokensArg ?? '512');
const dailyCapArg = argValue('--daily-cap');
if (dailyCapArg !== undefined && !/^[1-9]\d{0,30}$/.test(dailyCapArg))
  throw new UsageError('--daily-cap must be a positive integer (neuron)');
if (dailyCapArg !== undefined && BigInt(dailyCapArg) > s.dailyCapNeuron)
  throw new UsageError('--daily-cap may only lower ZG_DAILY_CAP_NEURON, never raise it');
const dailyCap = dailyCapArg === undefined ? s.dailyCapNeuron : BigInt(dailyCapArg);
const today = utcDay(new Date().toISOString());

console.log(
  `ledger call on 0G ${s.network} · database ${s.databasePath} (migration ${s.migration.current})`,
);
console.log(`  model        ${s.modelId} · max_tokens ${maxTokens}`);
console.log(`  per-call cap ${zg(s.capNeuron)}`);
console.log(
  `  daily cap    ${zg(dailyCap)}${dailyCapArg === undefined ? ' (ZG_DAILY_CAP_NEURON)' : ' (--daily-cap, this run only)'}`,
);
const before = await s.ledger.spentOnDay(today);
console.log(`  spent today  ${zg(before.spent)} over ${before.calls} ledger rows (UTC ${today})\n`);

const snap = async (label: string) => {
  if (!s.client.hasManagementKey) return;
  try {
    const shot = await takeBalanceSnapshot(
      { client: s.client, ledger: s.ledger, network: s.network },
      'manual',
    );
    console.log(`snapshot ${label.padEnd(6)} ${snapshotLine(shot)}`);
  } catch (error) {
    console.log(
      `snapshot ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

await snap('before');
const { models } = await s.client.listModels();
console.log('sending through the ledger (per-call cap → daily cap → ONE call, no retries) ...');
const r = await ledgeredStructuredCall(
  { client: s.client, ledger: s.ledger },
  {
    runId: null,
    purpose: 'ANALYZE',
    network: s.network,
    modelId: s.modelId,
    catalog: models,
    task: triageTask,
    maxTokens,
    capNeuron: s.capNeuron,
    dailyCapNeuron: dailyCap,
    timeoutMs: s.timeoutMs,
  },
);

let ok = false;
switch (r.kind) {
  case 'refused':
    console.log(`\nREFUSED ${r.code} (nothing sent): ${r.reason}`);
    ok = dailyCapArg !== undefined && r.code === 'DAILY_CAP_EXCEEDED';
    break;
  case 'router-error':
    console.log(`\nROUTER ERROR ${r.error.status} ${r.error.code ?? ''}: ${r.error.message}`);
    break;
  case 'unknown':
    console.log(`\nOUTCOME UNKNOWN (not retried; worst case stays counted): ${r.error}`);
    break;
  case 'completed': {
    const c = r.completion;
    console.log(`request_id   ${c.trace.requestId} · provider ${c.trace.provider}`);
    console.log(
      `usage        ${c.usage.promptTokens} in + ${c.usage.completionTokens} out · billed ${zg(c.trace.billing.totalCost)} · worst case ${zg(r.worstCase)} · tee_verified ${String(c.trace.teeVerified)}`,
    );
    if (r.reading.ok) {
      const match = idsMatchInput(r.reading.value);
      for (const a of r.reading.value.assessments)
        console.log(`  ${a.id.padEnd(20)} ${a.priority} · exploited ${a.exploitedInWild}`);
      console.log(`  ids          ${match ? 'exactly the two input advisories' : 'UNEXPECTED'}`);
      ok = match && r.call.status === 'SUCCEEDED';
    } else {
      console.log(`  OUTPUT REJECTED ${r.reading.code}: ${r.reading.reason}`);
    }
    break;
  }
}

console.log(`\nledger row   ${r.call.id}`);
console.log(`  ${callLine(r.call)}`);
const after = await s.ledger.spentOnDay(today);
console.log(
  `spent today  ${zg(after.spent)} of ${zg(dailyCap)} · remaining ${zg(dailyCap - after.spent > 0n ? dailyCap - after.spent : 0n)}`,
);
if (r.kind === 'completed') await snap('after');

console.log(
  ok
    ? r.kind === 'refused'
      ? '\nDAILY CAP ENFORCED: refused before sending, refusal recorded in the ledger.'
      : '\nLEDGERED CALL RECORDED: one SUCCEEDED row. Run pnpm ledger:reconcile in a few seconds.'
    : '\nNOT VERIFIED: see the lines above (the ledger row records what happened).',
);
s.db.close();
if (!ok) process.exitCode = 1;
