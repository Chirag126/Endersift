/**
 * The control center: what state the agent is in, what it may still spend
 * today and under which rules, what the latest run proved, and what ran
 * recently. Every figure comes from the API; nothing is simulated.
 */
import { useApp } from '../App.tsx';
import { ThemeSwitch } from '../components/ThemeSwitch.tsx';
import {
  Empty,
  ErrorNotice,
  Hbar,
  Loading,
  Meter,
  PageHead,
  Proof,
  StageTrack,
  Stale,
  Status,
  VerdictBadge,
  paymentText,
  paymentTone,
} from '../components/ui.tsx';
import { useApi, type Loaded } from '../hooks.tsx';
import { OutsideNote } from './Payments.tsx';
import { DayChart } from '../components/DayChart.tsx';
import { byDay, dayStart, lastUtcDays } from '../lib/activity.ts';
import { hashscanTopic } from '../lib/explorers.ts';
import { hbar, utcTime, zgAmount } from '../lib/format.ts';
import { originText } from '../lib/runs.ts';
import { STATE_TEXT, agentState } from '../lib/state.ts';
import type {
  Health,
  InferenceResponse,
  PaymentsResponse,
  PublicConfig,
  RunRecord,
  RunsResponse,
} from '../lib/types.ts';

const min = (a: bigint, b: bigint) => (a < b ? a : b);

function StatePanel({
  config,
  health,
  committedToday,
}: {
  config: PublicConfig;
  health: Loaded<Health>;
  committedToday: string | null;
}) {
  const state = agentState({
    reachable: health.error === null,
    running: health.data?.queue.running ?? null,
    pending: health.data?.queue.pending ?? 0,
    paymentsPaused: config.policy.paymentsPaused,
    approvalsPending: health.data?.approvals?.pending ?? 0,
  });
  const p = config.policy;
  const waiting = health.data?.approvals?.pending ?? 0;
  const left =
    committedToday === null
      ? null
      : (() => {
          const r = BigInt(p.maxPerDay) - BigInt(committedToday);
          return r > 0n ? r : 0n;
        })();
  const nextTask = left === null ? null : min(BigInt(p.maxPerRun), left);
  const running = health.data?.queue.running ?? null;

  return (
    <section className={`state state-${state}`} aria-labelledby="state-title">
      <h2 id="state-title" className="state-headline">
        {health.data === null && health.error === null ? 'Checking the agent…' : STATE_TEXT[state]}
      </h2>
      <p className="state-line">
        {state === 'unreachable' ? (
          'The API is not answering. Figures below may be out of date.'
        ) : state === 'blocked' ? (
          <>
            The kill switch is on: the firewall refuses every payment and new tasks cannot start.{' '}
            <a href="#/rules">Review the spending rules</a>
          </>
        ) : state === 'approval' && running !== null ? (
          <>
            {waiting} payment{waiting === 1 ? ' is' : 's are'} waiting for your approval; nothing is
            signed until you answer. <a href={`#/tasks/${running}`}>Answer on the task page</a>
          </>
        ) : running !== null ? (
          <>
            A task is running. <a href={`#/tasks/${running}`}>Follow it live</a>
            {(health.data?.queue.pending ?? 0) > 0
              ? `; ${health.data?.queue.pending} more waiting.`
              : '.'}
          </>
        ) : nextTask === null ? (
          'Loading today’s spending…'
        ) : nextTask === 0n ? (
          'Today’s HBAR limit is used up. New tasks can buy nothing until 00:00 UTC.'
        ) : (
          <>
            The next task may spend up to <Hbar tinybars={nextTask} />.
          </>
        )}
      </p>
      <dl className="state-facts">
        <div>
          <dt>Networks</dt>
          <dd>
            ENS on Sepolia, Hedera {config.networks.hedera}, 0G {config.networks.zg}
          </dd>
        </div>
        <div>
          <dt>Rules in force</dt>
          <dd>
            {p.source === 'owner'
              ? `Owner rules, version ${p.version ?? '?'}`
              : 'Server configuration (no owner changes saved)'}
            . <a href="#/rules">Change</a>
          </dd>
        </div>
        <div>
          <dt>Approval</dt>
          <dd>
            {p.approvalMode === 'human'
              ? BigInt(p.approvalAboveTinybars ?? '0') === 0n
                ? 'Human approval for every payment'
                : `Human approval above ${hbar(p.approvalAboveTinybars ?? '0')} HBAR`
              : 'Autonomous: no approval needed within the limits'}
            {waiting > 0 ? (
              <>
                {' '}
                · <a href="#/approvals">{waiting} waiting</a>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Per task</dt>
          <dd>
            <Hbar tinybars={p.maxPerRun} />, at most <Hbar tinybars={p.maxPerPayment} /> per payment
          </dd>
        </div>
        <div>
          <dt>Left today</dt>
          <dd>{left === null ? '…' : <Hbar tinybars={left} />}</dd>
        </div>
        <div>
          <dt>Brief for sale</dt>
          <dd>
            {config.earnings === undefined || config.earnings === null ? (
              'No: no earnings account is set'
            ) : (
              <>
                Yes, over x402. <a href="#/payments">Earnings</a>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>HCS audit topic</dt>
          <dd>
            {config.hcs === null ? (
              'Off: no audit messages are posted'
            ) : (
              <Proof
                value={config.hcs.topicId}
                href={hashscanTopic(config.networks.hedera, config.hcs.topicId)}
                label="HCS audit topic"
                full
              />
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function LatestRun({ run }: { run: RunRecord }) {
  const settled = run.payments.filter((p) => p.status === 'SETTLED');
  return (
    <article className="panel latest" aria-labelledby="latest-title">
      <header className="panel-head">
        <div>
          <h2 id="latest-title">Latest run</h2>
          <p className="hint">
            <a href={`#/tasks/${run.task.id}`}>{run.task.watchlist.join(', ')}</a>,{' '}
            {utcTime(run.task.createdAt)}. {originText(run.summary.origin)}.
          </p>
        </div>
        <VerdictBadge verdict={run.summary.verdict} />
      </header>
      <StageTrack stages={run.summary.stages} />
      {run.summary.gaps.length === 0 ? null : (
        <p className="hint">Not verified because: {run.summary.gaps.join('; ')}.</p>
      )}
      {settled.length === 0 ? null : (
        <ul className="proof-list">
          {settled.map((p) =>
            p.transactionId === null ? null : (
              <li key={p.id}>
                <span>{p.provider.split('.')[0]}</span>
                <Hbar tinybars={p.amountAtomic} />
                <Proof value={p.transactionId} href={p.hashscan} label="Hedera transaction" full />
              </li>
            ),
          )}
        </ul>
      )}
    </article>
  );
}

export function OverviewPage() {
  const { config } = useApp();
  const health = useApi<Health>('/api/health', 5_000);
  // the activity charts need the last week's rows; the lists show the newest few
  const runs = useApi<RunsResponse>('/api/runs?limit=50', 10_000);
  const payments = useApi<PaymentsResponse>('/api/payments?limit=200', 15_000);
  const inference = useApi<InferenceResponse>('/api/inference?limit=1', 15_000);
  const latest = runs.data?.runs[0];
  const recentRuns = runs.data?.runs.slice(0, 6) ?? [];
  const recentPayments = payments.data?.payments.slice(0, 5) ?? [];

  return (
    <>
      <PageHead
        title="Overview"
        hero
        kicker="Agent command center"
        intro={
          <span className="theme-extra">
            Finds threat-intel sellers on ENS, pays them on Hedera within your rules, and writes the
            brief with 0G.
          </span>
        }
        aside={
          <div className="overview-actions">
            <ThemeSwitch />
            <a
              className={`button button-primary${config.policy.paymentsPaused ? ' is-disabled' : ''}`}
              href="#/new"
            >
              New task
            </a>
          </div>
        }
      />

      <div className="overview-top">
        <StatePanel
          config={config}
          health={health}
          committedToday={payments.data?.today.committedAtomic ?? null}
        />
        <section className="panel today" aria-labelledby="today-title">
          <h2 id="today-title">Spent today</h2>
          {payments.data === null && payments.error !== null ? (
            <ErrorNotice error={payments.error} />
          ) : payments.data === null ? (
            <Loading what="spending" />
          ) : (
            <Meter
              label="HBAR, all tasks"
              used={payments.data.today.committedAtomic}
              limit={config.policy.maxPerDay}
              format={(v) => `${hbar(v)} HBAR`}
            />
          )}
          {inference.data === null ? (
            inference.error === null ? null : (
              <p className="hint">0G usage is unavailable: {inference.error.message}</p>
            )
          ) : (
            <>
              <Meter
                label={`0G ${config.networks.zg} inference, ${inference.data.today.calls} call${inference.data.today.calls === 1 ? '' : 's'}`}
                used={inference.data.today.spentNeuron}
                limit={config.zg.dailyCapNeuron}
                format={zgAmount}
              />
              <p className="hint">Against the daily 0G cap, not your 0G balance.</p>
            </>
          )}
          <p className="hint">
            In flight and unresolved payments count too. Limits reset at 00:00 UTC.
          </p>
          <OutsideNote outside={payments.data?.today.outside ?? null} />
          <Stale error={payments.error} updatedAt={payments.updatedAt} />
        </section>
      </div>

      <section className="zg-why" aria-labelledby="zg-why-title">
        <h2 id="zg-why-title">Why 0G is the product here</h2>
        <p>
          0G Private Computer (<code>{config.zg.model}</code>) decides which ENS-listed providers
          are worth paying on Hedera, then writes the brief from what was bought.{' '}
          <strong>Without 0G</strong>, nothing decides what to buy or writes the brief: every task
          would stop after ENS discovery, with nothing paid.
        </p>
      </section>

      {runs.data === null ? (
        runs.error === null ? (
          <Loading what="runs" />
        ) : (
          <ErrorNotice error={runs.error} />
        )
      ) : latest === undefined ? (
        <Empty title="No runs yet.">
          <p>
            <a href="#/new">Start the first task</a>: give the agent a watchlist and a budget. Its
            stages and proofs appear here.
          </p>
        </Empty>
      ) : (
        <LatestRun run={latest} />
      )}
      <Stale error={runs.error} updatedAt={runs.updatedAt} />

      <div className="overview-lists">
        <section aria-labelledby="recent-title">
          <div className="section-head">
            <h2 id="recent-title">Recent tasks</h2>
            <a href="#/evidence">All runs</a>
          </div>
          {recentRuns.length === 0 ? (
            <p className="hint">None yet.</p>
          ) : (
            <ul className="run-list">
              {recentRuns.map((r) => (
                <li key={r.task.id}>
                  <a href={`#/tasks/${r.task.id}`} className="run-list-name">
                    {r.task.watchlist.join(', ')}
                  </a>
                  <span className="hint">{utcTime(r.task.createdAt)}</span>
                  <StageTrack stages={r.summary.stages} compact />
                  <VerdictBadge verdict={r.summary.verdict} />
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="payments-title">
          <div className="section-head">
            <h2 id="payments-title">Recent payments</h2>
            <a href="#/payments">All payments</a>
          </div>
          {recentPayments.length === 0 ? (
            <p className="hint">None yet.</p>
          ) : (
            <ul className="side-list">
              {recentPayments.map((p) => (
                <li key={p.id}>
                  <div className="side-row">
                    <span>{p.provider.split('.')[0]}</span>
                    <Hbar tinybars={p.amountAtomic} />
                  </div>
                  <Status tone={paymentTone(p.status)}>{paymentText(p.status)}</Status>
                  {p.transactionId === null ? null : (
                    <Proof value={p.transactionId} href={p.hashscan} label="Hedera transaction" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="activity-title">
        <div className="section-head">
          <h2 id="activity-title">Last 7 days</h2>
        </div>
        {runs.data === null || payments.data === null ? (
          runs.error !== null ? (
            <ErrorNotice error={runs.error} />
          ) : payments.error !== null ? (
            <ErrorNotice error={payments.error} />
          ) : (
            <Loading what="activity" />
          )
        ) : (
          <div className="activity">
            {/* the week ends on the server's UTC day, as the spending limits do */}
            <DayChart
              title="Tasks"
              columns={byDay(
                runs.data.runs,
                lastUtcDays(7, dayStart(payments.data.today.day)),
                ['e2e-verified', 'completed-with-gaps', 'failed'],
                (r) => r.task.createdAt,
                // running tasks and mock-harness runs are not counted
                (r) =>
                  r.summary.verdict === 'e2e-verified' ||
                  r.summary.verdict === 'completed-with-gaps' ||
                  r.summary.verdict === 'failed'
                    ? r.summary.verdict
                    : null,
                () => 1n,
              )}
              series={[
                { key: 'e2e-verified', label: 'Verified', tone: 'good' },
                { key: 'completed-with-gaps', label: 'Finished with gaps', tone: 'warn' },
                { key: 'failed', label: 'Failed', tone: 'bad' },
              ]}
              format={(v) => `${v.toString()} task${v === 1n ? '' : 's'}`}
              empty="No finished tasks this week."
            />
            <DayChart
              title="HBAR settled"
              columns={byDay(
                payments.data.payments,
                lastUtcDays(7, dayStart(payments.data.today.day)),
                ['SETTLED'],
                (p) => p.settledAt ?? p.createdAt,
                (p) => (p.status === 'SETTLED' ? 'SETTLED' : null),
                (p) => BigInt(p.amountAtomic),
              )}
              series={[{ key: 'SETTLED', label: 'Settled', tone: 'proof' }]}
              format={(v) => `${hbar(v.toString())} HBAR`}
              empty="No settled payments this week."
            />
          </div>
        )}
      </section>
    </>
  );
}
