/**
 * Payments waiting for the owner, and the recent decisions (D-066). Every
 * row comes from GET /api/approvals; the prompts send the answer to the
 * server, which enforces it. In Autonomous mode (the default) this page is
 * normally empty, and says so.
 */
import { useApp } from '../App.tsx';
import { ApprovalPrompt, ApprovalState } from '../components/Approvals.tsx';
import { Empty, ErrorNotice, Hbar, Loading, PageHead, Stale } from '../components/ui.tsx';
import { useApi } from '../hooks.tsx';
import { hbar, utcTime } from '../lib/format.ts';
import type { ApprovalsResponse } from '../lib/types.ts';

export function ApprovalsPage() {
  const { config } = useApp();
  const pending = useApi<ApprovalsResponse>('/api/approvals?status=PENDING&limit=20', 5_000);
  const recent = useApi<ApprovalsResponse>('/api/approvals?limit=20', 15_000);
  const reload = () => {
    pending.reload();
    recent.reload();
  };
  const mode = pending.data?.mode ?? config.policy.approvalMode ?? 'autonomous';
  const above = pending.data?.aboveTinybars ?? config.policy.approvalAboveTinybars ?? '0';
  const decided = (recent.data?.approvals ?? []).filter((a) => a.status !== 'PENDING');

  return (
    <>
      <PageHead
        title="Approvals"
        intro={
          mode === 'human'
            ? `Human approval is on: ${BigInt(above) === 0n ? 'every payment' : `payments above ${hbar(above)} HBAR`} wait here for your answer before anything is signed.`
            : 'Autonomous mode is on (the default): payments within the spending rules go ahead without asking. Switch to Human approval under Spending rules.'
        }
        aside={
          <a className="button" href="#/rules">
            Spending rules
          </a>
        }
      />

      <section aria-labelledby="pending-title">
        <h2 id="pending-title">Waiting for you</h2>
        {pending.data === null ? (
          pending.error === null ? (
            <Loading what="approval requests" />
          ) : (
            <ErrorNotice error={pending.error} />
          )
        ) : pending.data.approvals.length === 0 ? (
          <Empty title="Nothing is waiting for your approval." />
        ) : (
          <div className="approvals-waiting">
            {pending.data.approvals.map((a) => (
              <div key={a.id}>
                <p className="hint">
                  For task <a href={`#/tasks/${a.runId}`}>{a.runId.slice(0, 8)}</a>
                </p>
                <ApprovalPrompt approval={a} onDecided={reload} />
              </div>
            ))}
          </div>
        )}
        <Stale error={pending.error} updatedAt={pending.updatedAt} />
      </section>

      <section aria-labelledby="decided-title">
        <h2 id="decided-title">Recent decisions</h2>
        {decided.length === 0 ? (
          <p className="hint">None on this server yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Asked</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Task</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((a) => (
                  <tr key={a.id}>
                    <td>{utcTime(a.requestedAt)}</td>
                    <td>{a.provider}</td>
                    <td>
                      <Hbar tinybars={a.amountAtomic} />
                    </td>
                    <td>
                      <ApprovalState approval={a} />
                      {a.note === null ? null : <span className="hint"> “{a.note}”</span>}
                    </td>
                    <td>
                      <a href={`#/tasks/${a.runId}`}>{a.runId.slice(0, 8)}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
