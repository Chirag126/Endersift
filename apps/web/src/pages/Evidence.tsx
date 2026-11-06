/**
 * Runs recorded by THIS deployment, each with its stages, proofs and raw
 * events, and the server's verdict (a failed or mock run is never shown as
 * verified). Development evidence files are no longer shown in the app
 * (D-089); the README carries the qualification references.
 */
import { useState } from 'react';
import { useApp } from '../App.tsx';
import {
  AuditList,
  Drawer,
  Empty,
  ErrorNotice,
  Hbar,
  JsonBlock,
  Loading,
  Notice,
  PageHead,
  Proof,
  StageTrack,
  Stale,
  Status,
  VerdictBadge,
  paymentText,
  paymentTone,
  runText,
} from '../components/ui.tsx';
import { useApi } from '../hooks.tsx';
import { utcTime, zgAmount } from '../lib/format.ts';
import { originText } from '../lib/runs.ts';
import { explainCode } from '../lib/timeline.ts';
import type { RunEvent, RunRecord, RunsResponse } from '../lib/types.ts';

const FUNDING_TEXT: Readonly<Record<string, string>> = {
  credits: 'Paid with credits.',
  deposit: 'Paid from the 0G deposit.',
  mixed: 'Paid with credits and the 0G deposit.',
  none: 'Not billed.',
  unknown: 'Funding not reconciled yet.',
};

function RawEvents({ runId }: { runId: string }) {
  const res = useApi<{ events: RunEvent[] }>(`/api/tasks/${encodeURIComponent(runId)}/events`);
  if (res.error !== null) return <ErrorNotice error={res.error} />;
  if (res.data === null) return <Loading what="the events" />;
  return (
    <>
      <p className="hint">
        {res.data.events.length} events, exactly as recorded (append-only), with secrets redacted by
        the server.
      </p>
      <JsonBlock value={res.data.events} label={`Raw events of run ${runId}`} />
    </>
  );
}

function RunCard({ run, onRaw }: { run: RunRecord; onRaw: () => void }) {
  const { config } = useApp();
  const s = run.summary;
  return (
    <li className="run-card">
      <header className="run-card-head">
        <div>
          <h3>
            <a href={`#/tasks/${run.task.id}`}>{run.task.watchlist.join(', ')}</a>
          </h3>
          <p className="hint">
            {utcTime(run.task.createdAt)}. {runText(run.task.status)}. {originText(s.origin)}.{' '}
            {s.environment === 'live' ? 'Live networks' : 'Mock harness'}
            {s.environmentSource === 'inferred' ? ' (inferred from the server mode)' : ''}.{' '}
            {s.policyVersion === null ? 'Server rules.' : `Owner rules v${s.policyVersion}.`}
          </p>
          <p className="hint run-id">
            Run <code>{run.task.id}</code>
          </p>
        </div>
        <VerdictBadge verdict={s.verdict} />
      </header>
      <StageTrack stages={s.stages} />
      {s.gaps.length === 0 ? null : (
        <p className="gaps">
          <span className="gaps-label">Why it is not verified:</span> {s.gaps.join('; ')}.
        </p>
      )}
      <div className="run-proofs">
        <div>
          <h4>Payments</h4>
          {run.payments.length === 0 ? (
            <p className="hint">None.</p>
          ) : (
            <ul className="side-list">
              {run.payments.map((p) => (
                <li key={p.id}>
                  <div className="side-row">
                    <span>{p.provider.split('.')[0]}</span>
                    <Hbar tinybars={p.amountAtomic} />
                  </div>
                  <Status tone={paymentTone(p.status)}>
                    {paymentText(p.status)}
                    {p.refusalCode === null ? null : `: ${explainCode(p.refusalCode)}`}
                  </Status>
                  {p.transactionId === null ? null : (
                    <Proof
                      value={p.transactionId}
                      href={p.hashscan}
                      label="Hedera transaction"
                      full
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>0G calls</h4>
          {run.inference.length === 0 ? (
            <p className="hint">None.</p>
          ) : (
            <ul className="side-list">
              {run.inference.map((c) => (
                <li key={c.id}>
                  <div className="side-row">
                    <span>
                      {c.purpose === 'ANALYZE'
                        ? 'Analysis'
                        : c.purpose === 'PLAN'
                          ? 'Plan'
                          : c.purpose}
                    </span>
                    <span className="money">
                      {c.costNeuron === null ? '–' : zgAmount(c.costNeuron)}
                    </span>
                  </div>
                  <span className="hint">
                    {c.status === 'SUCCEEDED' ? 'Done' : explainCode(c.status)}
                    {c.teeVerified === true ? ', TEE signature verified' : ''}.{' '}
                    {FUNDING_TEXT[c.funding] ?? c.funding}
                  </span>
                  {c.requestId === null ? null : (
                    <Proof value={c.requestId} label="0G request ID" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>HCS audit</h4>
          {run.audit.length === 0 ? (
            <p className="hint">
              {config.hcs === null ? 'Off on this server.' : 'No messages for this run.'}
            </p>
          ) : (
            <AuditList audit={run.audit} />
          )}
        </div>
      </div>
      <div className="run-actions">
        <button type="button" className="button-quiet" onClick={onRaw}>
          Raw events ({run.events})
        </button>
        <a href={`#/tasks/${run.task.id}`}>Open the task</a>
      </div>
    </li>
  );
}

export function EvidencePage() {
  const { config } = useApp();
  const runs = useApi<RunsResponse>('/api/runs?limit=20', 15_000);
  const [raw, setRaw] = useState<string | null>(null);

  return (
    <>
      <PageHead
        title="Runs"
        intro="Every task this server ran, with its verdict, payments and 0G calls."
      />

      <section aria-labelledby="runs-title">
        <h2 id="runs-title" className="sr-only">
          Runs of this deployment
        </h2>
        {config.mode === 'mock' ? (
          <Notice tone="warn">
            This server runs the mock harness: fake ENS, providers, Hedera and 0G. Its runs check
            the wiring and prove nothing about the networks.
          </Notice>
        ) : null}
        {runs.data === null ? (
          runs.error === null ? (
            <Loading what="runs" />
          ) : (
            <ErrorNotice error={runs.error} />
          )
        ) : runs.data.runs.length === 0 ? (
          <Empty title="No runs recorded yet.">
            <p>
              <a href="#/new">Start a task</a>. Its stages, transactions and raw events appear here.
            </p>
          </Empty>
        ) : (
          <ul className="run-cards">
            {runs.data.runs.map((r) => (
              <RunCard key={r.task.id} run={r} onRaw={() => setRaw(r.task.id)} />
            ))}
          </ul>
        )}
        <Stale error={runs.error} updatedAt={runs.updatedAt} />
      </section>

      <Drawer open={raw !== null} title="Raw events" onClose={() => setRaw(null)}>
        {raw === null ? null : <RawEvents runId={raw} />}
      </Drawer>
    </>
  );
}
