/** Every payment the agent made or was refused, with its Hedera transaction. */
import { useApp } from '../App.tsx';
import {
  Empty,
  ErrorNotice,
  Hbar,
  Loading,
  Meter,
  PageHead,
  Proof,
  Status,
  paymentText,
  paymentTone,
} from '../components/ui.tsx';
import { DayChart } from '../components/DayChart.tsx';
import { useApi } from '../hooks.tsx';
import { byDay, dayStart, lastUtcDays } from '../lib/activity.ts';
import { hbar, utcTime } from '../lib/format.ts';
import { explainCode } from '../lib/timeline.ts';
import { hashscanAccount } from '../lib/explorers.ts';
import type { EarningsResponse, OutsideSpend, PaymentsResponse } from '../lib/types.ts';

/** Payments made today that this server has no record of, found on the Mirror Node (D-062). */
export function OutsideNote({ outside }: { outside: OutsideSpend | null }) {
  if (outside === null || outside.count === 0) return null;
  return (
    <p className="hint">
      Includes {hbar(outside.atomic)} HBAR in {outside.count} payment
      {outside.count === 1 ? '' : 's'} this server has no record of (made before a restart or by
      another copy of the agent), found on the Hedera Mirror Node at {utcTime(outside.readAt)}. They
      count against today&rsquo;s limit.
    </p>
  );
}

/**
 * What the agent earned selling its own brief (D-066), read from the Hedera
 * Mirror Node by the server. Off unless the owner set an earnings account;
 * then it says so instead of showing zeros.
 */
export function EarningsSection() {
  const { config } = useApp();
  const enabled = config.earnings !== undefined && config.earnings !== null;
  const res = useApi<EarningsResponse>(enabled ? '/api/earnings' : null, 60_000);
  return (
    <section className="panel panel-wide earnings" aria-labelledby="earnings-title">
      <h2 id="earnings-title">Earned by selling the brief</h2>
      {!enabled ? (
        <p className="hint">
          Not for sale on this deployment. The provider service sells the agent&rsquo;s latest brief
          over x402 only when the owner sets an earnings account (
          <code>AGENT_EARNINGS_ACCOUNT</code>) and a price.
        </p>
      ) : res.error !== null ? (
        <ErrorNotice error={res.error} />
      ) : res.data === null ? (
        <Loading what="earnings" />
      ) : !res.data.enabled ? (
        <p className="hint">Not for sale on this deployment.</p>
      ) : (
        <>
          <p className="big-figure">
            <Hbar tinybars={res.data.tinybars} />
          </p>
          <p className="hint">
            Received by{' '}
            <Proof
              value={res.data.account}
              href={hashscanAccount(config.networks.hedera, res.data.account)}
              label="earnings account"
              full
            />{' '}
            in the last {res.data.windowDays} days, of which{' '}
            <Hbar tinybars={res.data.outsideTinybars} /> from buyers other than this agent&rsquo;s
            own payer. Read from the Mirror Node at {utcTime(res.data.readAt)}.
          </p>
          {res.data.sales.length === 0 ? (
            <p className="hint">No sales in this window.</p>
          ) : (
            <ul className="side-list">
              {res.data.sales.map((x) => (
                <li key={x.transactionId}>
                  <div className="side-row">
                    <span>
                      {x.fromOwnPayer
                        ? 'Own payer (self-test)'
                        : x.buyer === null
                          ? 'Buyer not identified'
                          : x.buyer}
                    </span>
                    <Hbar tinybars={x.tinybars} />
                  </div>
                  <Proof
                    value={x.transactionId}
                    href={x.hashscan}
                    label="Hedera transaction"
                    full
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function PaymentsPage() {
  const { config } = useApp();
  const res = useApi<PaymentsResponse>('/api/payments?limit=200', 15_000);

  return (
    <>
      <PageHead
        title="Payments"
        intro="Data the agent bought with x402 on Hedera. A payment is settled only once Hedera's Mirror Node confirms it."
      />
      {res.error !== null ? (
        <ErrorNotice error={res.error} />
      ) : res.data === null ? (
        <Loading what="payments" />
      ) : (
        <>
          <div className="panel panel-wide">
            <Meter
              label="Committed today, all tasks"
              used={res.data.today.committedAtomic}
              limit={config.policy.maxPerDay}
              format={(v) => `${hbar(v)} HBAR`}
            />
            <p className="hint">
              Settled, in flight and unresolved payments all count until the UTC day ends.
            </p>
            <OutsideNote outside={res.data.today.outside ?? null} />
          </div>
          <div className="panel panel-wide">
            <DayChart
              title="Payments, last 14 days"
              columns={byDay(
                res.data.payments,
                lastUtcDays(14, dayStart(res.data.today.day)),
                ['SETTLED', 'REFUSED'],
                (p) => p.settledAt ?? p.createdAt,
                (p) => (p.status === 'SETTLED' || p.status === 'REFUSED' ? p.status : null),
                () => 1n,
              )}
              series={[
                { key: 'SETTLED', label: 'Settled', tone: 'proof' },
                { key: 'REFUSED', label: 'Refused by the firewall', tone: 'warn' },
              ]}
              format={(v) => `${v.toString()} payment${v === 1n ? '' : 's'}`}
              empty="No payments in the last 14 days."
            />
          </div>
          <EarningsSection />
          {res.data.payments.length === 0 ? (
            <Empty title="No payments yet." />
          ) : (
            <div className="table-wrap">
              <table className="payments">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Provider</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Status</th>
                    <th scope="col">Hedera transaction</th>
                  </tr>
                </thead>
                <tbody>
                  {res.data.payments.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <a href={`#/tasks/${p.runId}`}>{utcTime(p.createdAt)}</a>
                      </td>
                      <td>
                        {p.provider}
                        <span className="cell-sub">{p.capability.replace(/-/g, ' ')}</span>
                      </td>
                      <td className="num">
                        <Hbar tinybars={p.amountAtomic} />
                      </td>
                      <td>
                        <Status tone={paymentTone(p.status)}>{paymentText(p.status)}</Status>
                        {p.refusalCode !== null || p.errorCode !== null ? (
                          <span className="cell-sub">
                            {explainCode(p.refusalCode ?? p.errorCode)}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        {p.transactionId === null ? (
                          <span className="hint">Nothing signed</span>
                        ) : (
                          <Proof
                            value={p.transactionId}
                            href={p.hashscan}
                            label="Hedera transaction"
                            full
                          />
                        )}
                      </td>
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
