/**
 * The brief (plan row 24, D-046). Rendered deterministically from what the
 * run recorded: the facts (ENS block, payments, transaction IDs, 0G request
 * IDs, advisory data) come from the stores and the purchased responses; only
 * the priorities, rationales and summary are model output, and they are
 * labelled as such. No extra inference call is spent on formatting.
 */
import type { InferenceCall, PaymentIntent, StackAnalysis } from '@agent-economy/core/domain';
import type { Delta, DigestItem } from './delta.ts';
import { dataLine, type SourcedItem } from './prompts.ts';

export interface ReportInput {
  readonly runId: string;
  readonly generatedAt: string;
  readonly watchlist: readonly string[];
  readonly ens: {
    readonly parent: string;
    readonly blockNumber: bigint;
    readonly providers: number;
  };
  readonly focus: string | null;
  readonly payments: readonly PaymentIntent[];
  readonly inference: readonly InferenceCall[];
  readonly items: readonly SourcedItem[];
  readonly triage: StackAnalysis | null;
  /** Why there is no accepted analysis, when advisories were bought but the analysis failed. */
  readonly analysisNote?: string | null;
  readonly skipped: readonly { readonly what: string; readonly code: string }[];
  readonly hashscan: (transactionId: string) => string;
  /** Changes since the previous brief for the same watchlist (D-056), or null with a note. */
  readonly delta?: Delta | null;
  readonly deltaNote?: string;
}

const pr = (p: string | null) => (p === null ? 'not prioritised' : p.toUpperCase());
const itemLine = (i: DigestItem) =>
  `${i.id} (${i.severity}${i.exploited ? ', in CISA KEV' : ''}${i.priority === null ? '' : `, ${i.priority.toUpperCase()}`})`;

function renderDelta(r: ReportInput, out: string[]): void {
  if (r.delta === undefined) return;
  out.push('## Since the previous brief', '');
  const d = r.delta;
  if (d === null) {
    out.push(`No comparison: ${r.deltaNote ?? 'nothing to compare with'}.`, '');
    return;
  }
  out.push(
    `Compared with the brief of ${d.previousAt.slice(0, 10)} (run \`${d.previousRunId}\`): ${d.added.length} new, ${d.gone.length} no longer in the analysed data, ${d.changed.length} priority change${d.changed.length === 1 ? '' : 's'}, ${d.unchanged} unchanged.`,
    '',
  );
  if (d.added.length > 0) {
    out.push('New:', '');
    for (const i of d.added) out.push(`- ${cell(itemLine(i))}`);
    out.push('');
  }
  if (d.changed.length > 0) {
    out.push('Priority changed (model):', '');
    for (const c of d.changed) out.push(`- ${cell(c.id)}: ${pr(c.from)} → ${pr(c.to)}`);
    out.push('');
  }
  if (d.gone.length > 0) {
    out.push('Not in this run’s analysed data (no longer returned, or not bought this time):', '');
    for (const i of d.gone) out.push(`- ${cell(itemLine(i))}`);
    out.push('');
  }
  if (d.added.length + d.gone.length + d.changed.length === 0)
    out.push('Nothing changed since the previous brief.', '');
}

const cell = (v: string): string => dataLine(v, 300).replace(/\|/g, '\\|');
const PRIORITY_ORDER = { p1: 0, p2: 1, p3: 2 } as const;

export function renderReport(r: ReportInput): string {
  const out: string[] = [];
  out.push(`# Threat brief · ${r.generatedAt.slice(0, 10)}`, '');
  out.push(`Run \`${r.runId}\` · generated ${r.generatedAt}`, '');
  out.push(`**Watchlist:** ${r.watchlist.map(cell).join(', ')}`, '');
  if (r.focus !== null) out.push(`**Plan (model):** ${cell(r.focus)}`, '');

  out.push('## Priorities', '');
  if (r.triage === null) {
    out.push(
      r.analysisNote !== undefined && r.analysisNote !== null
        ? `No analysis: ${r.analysisNote}. The paid data below is still on record.`
        : 'No analysis: no paid data reached the analyst in this run.',
      '',
    );
  } else if (r.triage.assessments.length === 0) {
    out.push(
      `None of the ${r.items.length} analysed advisories affects the watchlist (model).`,
      '',
      `**Summary (model):** ${cell(r.triage.summary)}`,
      '',
    );
  } else {
    const byId = new Map(r.items.map((s) => [s.item.id, s]));
    const sorted = [...r.triage.assessments].sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
    );
    out.push('| Priority | Advisory | Severity | In CISA KEV | Source | Rationale (model) |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const a of sorted) {
      const s = byId.get(a.id);
      out.push(
        `| ${a.priority.toUpperCase()} | ${a.id} | ${s?.item.severity ?? '-'}${
          s?.item.cvss?.score !== null && s?.item.cvss?.score !== undefined
            ? ` (${s.item.cvss.score})`
            : ''
        } | ${s?.item.exploited ? `since ${s.item.exploited.dateAdded}` : 'no'} | ${cell(
          s?.provider ?? '-',
        )} | ${cell(a.rationale)} |`,
      );
    }
    out.push('', `**Summary (model):** ${cell(r.triage.summary)}`, '');
  }

  renderDelta(r, out);

  out.push('## Paid data', '');
  if (r.payments.length === 0) out.push('No payments in this run.', '');
  else {
    out.push('| Provider | Capability | Amount (tinybars) | Status | Transaction |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const p of r.payments)
      out.push(
        `| ${p.provider} | ${p.capability} | ${p.amountAtomic} | ${p.status}${
          p.refusalCode !== null
            ? ` (${p.refusalCode})`
            : p.errorCode !== null
              ? ` (${p.errorCode})`
              : ''
        } | ${p.transactionId === null ? '-' : `[${p.transactionId}](${r.hashscan(p.transactionId)})`} |`,
      );
    const settled = r.payments
      .filter((p) => p.status === 'SETTLED')
      .reduce((sum, p) => sum + BigInt(p.amountAtomic), 0n);
    out.push('', `Settled and verified on the Mirror Node: ${settled} tinybars.`, '');
  }
  if (r.skipped.length > 0) {
    out.push('Not bought:', '');
    for (const s of r.skipped) out.push(`- ${cell(s.what)}: \`${s.code}\``);
    out.push('');
  }

  out.push('## Inference (0G)', '');
  out.push('| Purpose | Status | Request ID | Cost (neuron) | Funding |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const c of r.inference)
    out.push(
      `| ${c.purpose} | ${c.status}${c.errorCode === null ? '' : ` (${cell(c.errorCode)})`} | ${
        c.requestId ?? '-'
      } | ${c.costNeuron ?? '-'} | ${c.funding} |`,
    );
  out.push('');

  out.push('## Provenance', '');
  out.push(
    `Providers discovered on ENS (${r.ens.parent}) at Sepolia block ${r.ens.blockNumber}: ${r.ens.providers}.`,
    `Advisories analysed: ${r.items.length}. Priorities, rationales, the plan and the summary are model output; everything else is recorded data.`,
    '',
  );
  return out.join('\n');
}
