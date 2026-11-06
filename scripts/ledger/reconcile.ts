/**
 * Compare the inference ledger with the Router's usage history, the data the
 * dashboard's Usage page shows (plan row 18 acceptance: rows match dashboard usage).
 *
 *   pnpm ledger:reconcile                    compare, store funding splits of matched rows
 *   pnpm ledger:reconcile -- --save-evidence also write docs/evidence/zg/ledger-*.json
 *   pnpm ledger:reconcile -- --strict        also fail on Router calls the ledger never saw
 *
 * Needs ZG_MANAGEMENT_KEY (mk-, scope account:read). The Router returns at most
 * the 50 most recent entries; older ledger rows are reported OUT_OF_WINDOW.
 */
import { parseUsageHistory, utcDay } from '../../packages/zg/src/index.ts';
import {
  fundingOf,
  pendingPortion,
  reconcileWithUsage,
} from '../../apps/server/src/ledger/reconcile.ts';
import { handleScriptErrors, hasFlag, writeEvidence } from '../lib/cli.ts';
import { ledgerSetup, snapshotLine, zg } from './shared.ts';

handleScriptErrors();

const s = ledgerSetup({ needManagementKey: true });
const strict = hasFlag('--strict');
const startedAt = new Date().toISOString();

const history = parseUsageHistory(await s.client.getUsageHistory(50));
const calls = await s.ledger.listCalls();
const rec = reconcileWithUsage(calls, history.entries);

console.log(`ledger ↔ Router usage on 0G ${s.network} · database ${s.databasePath}`);
console.log(
  `  ledger rows ${calls.length} · Router entries ${history.entries.length}${history.unparsed > 0 ? ` (+${history.unparsed} unparsed)` : ''} · window from ${rec.windowStart ?? '-'}\n`,
);

const reconciledAt = new Date().toISOString();
for (const row of rec.rows) {
  const c = row.call;
  console.log(
    `${row.outcome.padEnd(17)} ${c.createdAt}  ${c.status.padEnd(9)} ${(c.requestId ?? '-').padEnd(36)}  ledger ${zg(c.costNeuron)}`,
  );
  if (row.entry !== null) {
    const e = row.entry;
    console.log(
      `${''.padEnd(17)} Router ${e.createdAt}  ${e.inputTokens}+${e.outputTokens} tokens  cost ${zg(e.cost)}  credit ${zg(e.creditUsed)}  deposit ${zg(e.depositUsed)}  pending ${zg(pendingPortion(e))}`,
    );
  }
  for (const d of row.diffs)
    console.log(`${''.padEnd(17)} DIFF ${d.field}: ledger ${d.ledger} ≠ Router ${d.router}`);
  if (row.outcome === 'MATCH' && row.entry !== null && c.costNeuron !== null)
    await s.ledger.reconcile(c.id, fundingOf(row.entry), reconciledAt);
}
for (const e of rec.unledgered)
  console.log(
    `UNLEDGERED        ${e.createdAt}  Router call the ledger never saw: ${e.requestId} cost ${zg(e.cost)}`,
  );

const today = utcDay(startedAt);
const spend = await s.ledger.spentOnDay(today);
const snapshots = await s.ledger.listBalanceSnapshots(5);
console.log(
  `\ncounts       ${
    Object.entries(rec.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(' · ') || 'none'
  }`,
);
console.log(
  `spent today  ${zg(spend.spent)} of ${zg(s.dailyCapNeuron)} (UTC ${today}, ${spend.calls} rows)`,
);
for (const snap of snapshots.slice(0, 3)) console.log(`snapshot     ${snapshotLine(snap)}`);

const verified = rec.verdict === 'MATCH' && (!strict || rec.unledgered.length === 0);

if (hasFlag('--save-evidence')) {
  const reconciled = await s.ledger.listCalls();
  const path = writeEvidence('zg', verified ? 'ledger' : 'ledger-attempt', {
    kind: 'zg-ledger-reconciliation',
    startedAt,
    finishedAt: new Date().toISOString(),
    network: s.network,
    baseUrl: s.client.baseUrl,
    model: s.modelId,
    perCallCapNeuron: s.capNeuron,
    dailyCapNeuron: s.dailyCapNeuron,
    strict,
    windowStart: rec.windowStart,
    counts: rec.counts,
    rows: rec.rows.map((r) => ({
      outcome: r.outcome,
      diffs: r.diffs,
      ledger: reconciled.find((c) => c.id === r.call.id) ?? r.call,
      router: r.entry === null ? null : { ...r.entry.raw, pendingPortion: pendingPortion(r.entry) },
    })),
    unledgered: rec.unledgered.map((e) => ({
      requestId: e.requestId,
      cost: e.cost,
      createdAt: e.createdAt,
    })),
    daySpend: {
      day: today,
      spentNeuron: spend.spent,
      calls: spend.calls,
      byStatus: spend.byStatus,
    },
    balanceSnapshots: snapshots,
    verdict: rec.verdict,
    ledgerMatchesRouterUsage: verified,
  });
  console.log(`\nEvidence written to ${path}`);
}

console.log(
  verified
    ? `\nLEDGER MATCHES ROUTER USAGE: ${rec.counts.MATCH} row(s) equal the Router's usage entries field for field.`
    : rec.verdict === 'NOTHING_TO_MATCH'
      ? '\nNOTHING TO MATCH: no billed ledger row has a Router entry yet (run pnpm ledger:call, wait a few seconds).'
      : '\nNOT VERIFIED: see MISMATCH / BILLED_UNRECORDED / MISSING_IN_ROUTER (or UNLEDGERED with --strict) above.',
);
s.db.close();
if (!verified) process.exitCode = 1;
