/**
 * One task, live: the trail of everything the agent did, each step beside
 * its proof; what it paid and what 0G cost; then the brief.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../App.tsx';
import { ApprovalPrompt, ApprovalState } from '../components/Approvals.tsx';
import { Markdown } from '../components/Markdown.tsx';
import {
  Drawer,
  Empty,
  ErrorNotice,
  Hbar,
  JsonBlock,
  Loading,
  PageHead,
  Proof,
  StageTrack,
  Status,
  VerdictBadge,
  AuditList,
  paymentText,
  paymentTone,
  runText,
  runTone,
} from '../components/ui.tsx';
import { useApi, useTaskEvents } from '../hooks.tsx';
import { getText } from '../lib/api.ts';
import { etherscanBlock, hashscanAccount } from '../lib/explorers.ts';
import { utcTime, zgAmount } from '../lib/format.ts';
import { AUDIT_REFRESH_FOR_MS, AUDIT_REFRESH_MS, auditSettling } from '../lib/runs.ts';
import { explainCode, isTerminalEvent, stepOf, type Proof as StepProof } from '../lib/timeline.ts';
import type { TaskDetail } from '../lib/types.ts';

function ProofFor({ proof }: { proof: StepProof }) {
  const { config } = useApp();
  switch (proof.kind) {
    case 'ens-block':
      return (
        <span className="proof-line">
          <span className="proof-label">ENS block</span>
          <Proof
            value={proof.value}
            href={etherscanBlock(proof.value)}
            label="Sepolia block"
            full
          />
        </span>
      );
    case 'tx':
      return (
        <span className="proof-line">
          <span className="proof-label">Hedera tx</span>
          <Proof value={proof.value} href={proof.href} label="Hedera transaction" full />
        </span>
      );
    case 'request':
      return (
        <span className="proof-line">
          <span className="proof-label">0G request</span>
          <Proof value={proof.value} label="0G request ID" />
        </span>
      );
    case 'account':
      return (
        <span className="proof-line">
          <span className="proof-label">Paid to</span>
          <Proof
            value={proof.value}
            href={hashscanAccount(config.networks.hedera, proof.value)}
            label="Hedera account"
            full
          />
        </span>
      );
  }
}

const STREAM_TEXT = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  ended: 'Complete',
} as const;

export function TaskPage({ taskId }: { taskId: string }) {
  const { config } = useApp();
  const { events, state, error } = useTaskEvents(taskId);
  const detail = useApi<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`);
  const [brief, setBrief] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const firstBatch = useRef<number | null>(null);

  // steps that arrive after the first load are highlighted once
  if (firstBatch.current === null && events.length > 0)
    firstBatch.current = events.at(-1)?.seq ?? -1;
  const steps = useMemo(() => events.map(stepOf), [events]);
  const lastType = events.at(-1)?.type;
  const reloadDetail = detail.reload;

  // refresh payments and 0G rows whenever the trail moves
  useEffect(() => {
    if (events.length > 0) reloadDetail();
  }, [events.length, reloadDetail]);

  // the HCS audit is posted after the run ends, with no new event: ask again for a while (D-086)
  const finished = lastType !== undefined && isTerminalEvent(lastType);
  const settling =
    finished && detail.data !== null && auditSettling(detail.data.audit, config.hcs !== null);
  const settlingSince = useRef<number | null>(null);
  useEffect(() => {
    if (!settling) {
      settlingSince.current = null;
      return undefined;
    }
    const since = (settlingSince.current ??= Date.now());
    if (Date.now() - since > AUDIT_REFRESH_FOR_MS) return undefined;
    const id = window.setTimeout(reloadDetail, AUDIT_REFRESH_MS);
    return () => window.clearTimeout(id);
  }, [settling, detail.data, reloadDetail]);

  const hasReport = events.some((e) => e.type === 'REPORT_WRITTEN');
  useEffect(() => {
    if (!hasReport) return;
    let alive = true;
    getText(`/api/tasks/${encodeURIComponent(taskId)}/report`)
      .then((md) => {
        if (alive) setBrief(md);
      })
      .catch(() => {
        if (alive) setBrief(null);
      });
    return () => {
      alive = false;
    };
  }, [hasReport, taskId]);

  if (error !== null) return <ErrorNotice error={error} />;
  const task = detail.data?.task;
  const startPolicy = events.find((e) => e.type === 'RUN_STARTED')?.payload['policy'];
  const budget =
    typeof startPolicy === 'object' && startPolicy !== null
      ? (startPolicy as Record<string, unknown>)['maxPerRun']
      : undefined;
  const approvals = detail.data?.approvals ?? [];
  const pending = approvals.filter((a) => a.status === 'PENDING');
  const settled = (detail.data?.payments ?? [])
    .filter((p) => p.status === 'SETTLED')
    .reduce((s, p) => s + BigInt(p.amountAtomic), 0n);

  return (
    <>
      <PageHead
        title={task === undefined ? 'Task' : task.watchlist.join(', ')}
        intro={
          task === undefined ? null : (
            <>
              Started {utcTime(task.createdAt)}.
              {task.error === null ? null : (
                <> Stopped because {explainCode(task.error.split(':')[0])}.</>
              )}
            </>
          )
        }
        aside={
          task === undefined ? null : (
            <div className="head-status">
              <Status tone={runTone(task.status)}>{runText(task.status)}</Status>
              <span className={`stream stream-${state}`}>{STREAM_TEXT[state]}</span>
            </div>
          )
        }
      />

      {detail.data === null ? null : (
        <section className="panel run-summary" aria-label="Stages">
          <header className="panel-head">
            <VerdictBadge verdict={detail.data.summary.verdict} />
            <button type="button" className="button-quiet" onClick={() => setRaw(true)}>
              Raw events ({events.length})
            </button>
          </header>
          <StageTrack stages={detail.data.summary.stages} />
          {detail.data.summary.gaps.length === 0 ? null : (
            <p className="hint">Not verified because: {detail.data.summary.gaps.join('; ')}.</p>
          )}
        </section>
      )}
      {pending.length === 0 ? null : (
        <section className="approvals-waiting" aria-label="Payments waiting for your approval">
          {pending.map((a) => (
            <ApprovalPrompt key={a.id} approval={a} onDecided={reloadDetail} />
          ))}
        </section>
      )}
      <Drawer open={raw} title="Raw events" onClose={() => setRaw(false)}>
        <p className="hint">Exactly as recorded, with secrets redacted by the server.</p>
        <JsonBlock value={events} label="Raw events of this task" />
      </Drawer>

      <div className="split">
        <section className="split-main" aria-labelledby="trail-title">
          <h2 id="trail-title">What the agent did</h2>
          {steps.length === 0 ? (
            state === 'ended' ? (
              <Empty title="Nothing was recorded for this task." />
            ) : (
              <Loading what="the trail" />
            )
          ) : (
            <ol className="trail" aria-live="polite" aria-relevant="additions">
              {steps.map((s) => (
                <li
                  key={s.seq}
                  className={`step step-${s.tone}${
                    firstBatch.current !== null && s.seq > firstBatch.current ? ' step-new' : ''
                  }`}
                >
                  <span className="step-seq" aria-hidden="true">
                    {s.seq + 1}
                  </span>
                  <div className="step-body">
                    <p className="step-title">{s.title}</p>
                    {s.detail === null ? null : <p className="step-detail">{s.detail}</p>}
                    <time className="step-time" dateTime={s.at}>
                      {utcTime(s.at)}
                    </time>
                  </div>
                  <div className="step-proofs">
                    {s.proofs.map((p) => (
                      <ProofFor key={`${p.kind}-${p.value}`} proof={p} />
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {state !== 'ended' && lastType !== undefined ? (
            <p className="hint">
              The trail updates as the agent works; you can leave and come back.
            </p>
          ) : null}
        </section>

        <aside className="split-side">
          <h2>Spent</h2>
          <p className="big-figure">
            <Hbar tinybars={settled} />
          </p>
          <p className="hint">
            Settled and verified
            {typeof budget === 'string' ? (
              <>
                {' '}
                of a <Hbar tinybars={budget} /> budget
              </>
            ) : null}
          </p>
          <h3>Payments</h3>
          {detail.data === null || detail.data.payments.length === 0 ? (
            <p className="hint">No payments yet.</p>
          ) : (
            <ul className="side-list">
              {detail.data.payments.map((p) => (
                <li key={p.id}>
                  <div className="side-row">
                    <span>{p.provider.split('.')[0]}</span>
                    <Hbar tinybars={p.amountAtomic} />
                  </div>
                  {p.status === 'AUTHORIZED' && pending.some((a) => a.paymentId === p.id) ? (
                    <Status tone="warn">Allowed by the firewall, waiting for your approval</Status>
                  ) : (
                    <Status tone={paymentTone(p.status)}>
                      {paymentText(p.status)}
                      {p.refusalCode === null ? null : `: ${explainCode(p.refusalCode)}`}
                    </Status>
                  )}
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
          {approvals.length === 0 ? null : (
            <>
              <h3>Approvals</h3>
              <ul className="side-list">
                {approvals.map((a) => (
                  <li key={a.id}>
                    <div className="side-row">
                      <span>{a.provider.split('.')[0]}</span>
                      <Hbar tinybars={a.amountAtomic} />
                    </div>
                    <ApprovalState approval={a} />
                    {a.note === null ? null : <span className="hint">“{a.note}”</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>HCS audit</h3>
          {config.hcs === null ? (
            <p className="hint">Off: this server has no audit topic.</p>
          ) : detail.data === null || detail.data.audit.length === 0 ? (
            <p className="hint">
              Posted to topic {config.hcs.topicId} when the task ends: each settlement and a digest.
            </p>
          ) : (
            <AuditList audit={detail.data.audit} />
          )}
          <h3>0G inference</h3>
          {detail.data === null || detail.data.inference.length === 0 ? (
            <p className="hint">No 0G calls yet.</p>
          ) : (
            <ul className="side-list">
              {detail.data.inference.map((c) => (
                <li key={c.id}>
                  <div className="side-row">
                    <span>
                      {c.purpose === 'PLAN'
                        ? 'Plan'
                        : c.purpose === 'ANALYZE'
                          ? 'Analysis'
                          : c.purpose === 'TRANSCRIBE'
                            ? 'Voice watchlist'
                            : c.purpose}
                    </span>
                    <span className="money">
                      {c.costNeuron === null ? '–' : zgAmount(c.costNeuron)}
                    </span>
                  </div>
                  <Status
                    tone={
                      c.status === 'SUCCEEDED' ? 'good' : c.status === 'PENDING' ? 'warn' : 'bad'
                    }
                  >
                    {c.status === 'SUCCEEDED' ? 'Done' : explainCode(c.errorCode ?? c.status)}
                  </Status>
                  {c.requestId === null ? null : (
                    <Proof value={c.requestId} label="0G request ID" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <section className="brief-section" aria-labelledby="brief-title">
        <h2 id="brief-title">Brief</h2>
        {brief !== null ? (
          <Markdown source={brief} />
        ) : hasReport ? (
          <Loading what="the brief" />
        ) : (
          <p className="hint">The brief appears here when the agent has written it.</p>
        )}
      </section>
    </>
  );
}
