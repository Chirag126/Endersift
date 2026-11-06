/** The 0G inference ledger: every call with its request ID, tokens, exact bill and TEE status. */
import { useApp } from '../App.tsx';
import { Empty, ErrorNotice, Loading, Meter, PageHead, Proof, Status } from '../components/ui.tsx';
import { DayChart } from '../components/DayChart.tsx';
import { useApi } from '../hooks.tsx';
import { byDay, dayStart, lastUtcDays } from '../lib/activity.ts';
import { utcTime, zgAmount } from '../lib/format.ts';
import { explainCode } from '../lib/timeline.ts';
import type { InferenceResponse } from '../lib/types.ts';

const PURPOSE: Readonly<Record<string, string>> = {
  PLAN: 'Plan',
  ANALYZE: 'Analysis',
  SELECT: 'Selection',
  REPORT: 'Report',
  PROBE: 'Probe',
  TRANSCRIBE: 'Voice (speech to text)',
};

const FUNDING: Readonly<Record<string, string>> = {
  credits: 'Credits',
  deposit: 'Testnet deposit',
  mixed: 'Credits and deposit',
  none: 'Not billed',
  unknown: 'Not reconciled yet',
};

export function UsagePage() {
  const { config } = useApp();
  const res = useApi<InferenceResponse>('/api/inference?limit=100', 15_000);

  return (
    <>
      <PageHead
        title="0G usage"
        intro={`Every 0G Private Computer call (${config.zg.model}, ${config.networks.zg}), with its request ID and bill.`}
      />
      {res.error !== null ? (
        <ErrorNotice error={res.error} />
      ) : res.data === null ? (
        <Loading what="the ledger" />
      ) : (
        <>
          <div className="panel panel-wide">
            <Meter
              label="Spent today"
              used={res.data.today.spentNeuron}
              limit={config.zg.dailyCapNeuron}
              format={zgAmount}
            />
            <p className="hint">
              {res.data.today.calls} call{res.data.today.calls === 1 ? '' : 's'} today (UTC). At
              most {zgAmount(config.zg.capNeuron)} per call.
            </p>
          </div>
          <div className="panel panel-wide">
            <DayChart
              title="0G calls, last 14 days"
              columns={byDay(
                res.data.calls,
                lastUtcDays(14, dayStart(res.data.today.day)),
                ['SUCCEEDED', 'FAILED'],
                (c) => c.createdAt,
                (c) =>
                  c.status === 'SUCCEEDED' ? 'SUCCEEDED' : c.status === 'FAILED' ? 'FAILED' : null,
                () => 1n,
              )}
              series={[
                { key: 'SUCCEEDED', label: 'Answered', tone: 'proof' },
                { key: 'FAILED', label: 'Failed', tone: 'bad' },
              ]}
              format={(v) => `${v.toString()} call${v === 1n ? '' : 's'}`}
              empty="No 0G calls in the last 14 days."
            />
          </div>
          {res.data.calls.length === 0 ? (
            <Empty title="No 0G calls yet." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Step</th>
                    <th scope="col">Status</th>
                    <th scope="col">Request ID</th>
                    <th scope="col">Tokens in / out</th>
                    <th scope="col">Billed</th>
                    <th scope="col">Reserved first</th>
                    <th scope="col">TEE</th>
                    <th scope="col">Paid from</th>
                  </tr>
                </thead>
                <tbody>
                  {res.data.calls.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.runId === null ? (
                          utcTime(c.createdAt)
                        ) : (
                          <a href={`#/tasks/${c.runId}`}>{utcTime(c.createdAt)}</a>
                        )}
                      </td>
                      <td>{PURPOSE[c.purpose] ?? c.purpose}</td>
                      <td>
                        <Status
                          tone={
                            c.status === 'SUCCEEDED'
                              ? 'good'
                              : c.status === 'PENDING' || c.status === 'UNKNOWN'
                                ? 'warn'
                                : 'bad'
                          }
                        >
                          {c.status === 'SUCCEEDED'
                            ? 'Done'
                            : c.status === 'REFUSED'
                              ? 'Not sent'
                              : c.status.toLowerCase()}
                        </Status>
                        {c.errorCode === null ? null : (
                          <span className="cell-sub">{explainCode(c.errorCode)}</span>
                        )}
                      </td>
                      <td>
                        {c.requestId === null ? (
                          <span className="hint">None</span>
                        ) : (
                          <Proof value={c.requestId} label="0G request ID" />
                        )}
                      </td>
                      <td className="num">
                        {c.promptTokens ?? '–'} / {c.completionTokens ?? '–'}
                      </td>
                      <td className="num">
                        {c.costNeuron === null ? '–' : zgAmount(c.costNeuron)}
                      </td>
                      <td className="num">
                        {c.worstCaseNeuron === null ? '–' : zgAmount(c.worstCaseNeuron)}
                      </td>
                      <td>
                        {c.teeVerified === true
                          ? 'Verified'
                          : c.teeVerified === false
                            ? 'Invalid'
                            : '–'}
                      </td>
                      <td>{FUNDING[c.funding] ?? c.funding}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
