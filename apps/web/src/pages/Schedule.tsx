/**
 * The daily brief (plan row 28, D-056): watchlists the server briefs once per
 * UTC day after a set time, within a budget, each brief compared with the
 * previous one. The scheduler runs inside the API server; this page only
 * shows and changes the schedules.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../App.tsx';
import {
  Empty,
  ErrorNotice,
  Hbar,
  Loading,
  Notice,
  PageHead,
  Stale,
  Status,
  VerdictBadge,
  runText,
  runTone,
} from '../components/ui.tsx';
import { useApi } from '../hooks.tsx';
import { ApiError, postJson, putJson } from '../lib/api.ts';
import { hbar, utcTime } from '../lib/format.ts';
import { checkSchedule, passedToday, whenText, type ScheduleDraft } from '../lib/schedule.ts';
import { explainCode } from '../lib/timeline.ts';
import type { ScheduleInfo, SchedulesResponse } from '../lib/types.ts';
import { AccessForm } from './NewTask.tsx';

const offset = new Date().getTimezoneOffset();

function ScheduleForm({
  initial,
  submitLabel,
  onSave,
  onCancel,
  ranToday = false,
}: {
  initial: ScheduleDraft;
  submitLabel: string;
  /** Today's brief already ran: saving cannot start another one today. */
  ranToday?: boolean;
  onSave: (body: { watchlist: string[]; budget: string; runAfter: string }) => Promise<void>;
  onCancel?: () => void;
}) {
  const { config, authenticated } = useApp();
  const [draft, setDraft] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const check = checkSchedule(draft, config.policy.maxPerRun);
  const err = (k: keyof ScheduleDraft) => (touched && !check.ok ? check.errors[k] : undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!check.ok || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(check.body);
    } catch (x) {
      setError(x instanceof ApiError ? x : new ApiError(0, 'UNREACHABLE', String(x), null));
    } finally {
      setSaving(false);
    }
  };
  const id = (k: string) => `${submitLabel.replace(/\W/g, '')}-${k}`;

  return (
    <form className="composer schedule-form" onSubmit={(e) => void submit(e)} aria-busy={saving}>
      <label htmlFor={id('watchlist')}>Watchlist</label>
      <textarea
        id={id('watchlist')}
        rows={3}
        value={draft.watchlist}
        placeholder={'OpenSSL\nlodash@4.17.20 (npm)'}
        onChange={(e) => setDraft({ ...draft, watchlist: e.target.value })}
        disabled={!authenticated}
      />
      {err('watchlist') === undefined ? null : <p className="field-error">{err('watchlist')}</p>}
      <div className="schedule-fields">
        <div>
          <label htmlFor={id('budget')}>Budget per brief</label>
          <div className="row budget-row">
            <input
              id={id('budget')}
              inputMode="decimal"
              value={draft.budget}
              onChange={(e) => setDraft({ ...draft, budget: e.target.value })}
              disabled={!authenticated}
            />
            <span className="unit-label">HBAR</span>
          </div>
          {err('budget') === undefined ? null : <p className="field-error">{err('budget')}</p>}
        </div>
        <div>
          <label htmlFor={id('time')}>Run after (UTC)</label>
          <input
            id={id('time')}
            className="time-input"
            value={draft.runAfter}
            placeholder="00:15"
            onChange={(e) => setDraft({ ...draft, runAfter: e.target.value })}
            disabled={!authenticated}
          />
          {err('runAfter') === undefined ? (
            check.ok ? (
              <p className="hint">{whenText(check.body.runAfter, offset)}</p>
            ) : null
          ) : (
            <p className="field-error">{err('runAfter')}</p>
          )}
        </div>
      </div>
      {check.ok && !ranToday && passedToday(check.body.runAfter, new Date()) ? (
        <Notice tone="warn">
          {check.body.runAfter} UTC has already passed today, so the first brief starts as soon as
          you save, and may spend up to <Hbar tinybars={check.body.budget} /> on Hedera testnet plus
          0G inference.
        </Notice>
      ) : null}
      {error === null ? null : (
        <div className="notice notice-bad" role="alert">
          <p>{error.message}</p>
          {error.problems.length === 0 ? null : (
            <ul>
              {error.problems.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="row">
        <button type="submit" className="button button-primary" disabled={!authenticated || saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        {onCancel === undefined ? null : (
          <button type="button" className="button-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ScheduleCard({ s, reload }: { s: ScheduleInfo; reload: () => void }) {
  const { authenticated } = useApp();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const body = { watchlist: [...s.watchlist], budget: s.budget, runAfter: s.runAfter };

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await putJson(`/api/schedules/${s.id}`, { ...body, enabled: !s.enabled });
      reload();
    } catch (x) {
      setError(x instanceof ApiError ? x : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`schedule-card${s.enabled ? '' : ' schedule-off'}`}>
      <header className="run-card-head">
        <div>
          <h3>{s.watchlist.join(', ')}</h3>
          <p className="hint">
            {whenText(s.runAfter, offset)}. Up to <Hbar tinybars={s.budget} /> per brief.
          </p>
          <p className="hint">
            {s.enabled
              ? s.nextRunAt === null
                ? ''
                : `Next brief: ${utcTime(s.nextRunAt)}, if the server is running.`
              : 'Paused: no briefs until it is turned back on.'}
          </p>
        </div>
        <Status tone={s.enabled ? 'good' : 'neutral'}>{s.enabled ? 'On' : 'Off'}</Status>
      </header>
      {s.lastSkip === null ? null : (
        <p className="gaps">
          <span className="gaps-label">Today’s brief has not started:</span>{' '}
          {explainCode(s.lastSkip.split(':')[0])}. The server tries again every minute until the UTC
          day ends.
        </p>
      )}
      {error === null ? null : <ErrorNotice error={error} />}

      {editing ? (
        <ScheduleForm
          initial={{
            watchlist: s.watchlist.join('\n'),
            budget: hbar(s.budget),
            runAfter: s.runAfter,
          }}
          submitLabel="Save schedule"
          ranToday={s.runs.some((r) => r.day === new Date().toISOString().slice(0, 10))}
          onCancel={() => setEditing(false)}
          onSave={async (b) => {
            await putJson(`/api/schedules/${s.id}`, { ...b, enabled: s.enabled });
            setEditing(false);
            reload();
          }}
        />
      ) : (
        <div className="run-actions">
          <button
            type="button"
            className="button-quiet"
            disabled={!authenticated || busy}
            onClick={() => void toggle()}
          >
            {s.enabled ? 'Turn off' : 'Turn on'}
          </button>
          <button
            type="button"
            className="button-quiet"
            disabled={!authenticated}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
        </div>
      )}

      <h4>Briefs</h4>
      {s.runs.length === 0 ? (
        <p className="hint">None yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="schedule-runs">
            <thead>
              <tr>
                <th scope="col">UTC day</th>
                <th scope="col">Run</th>
                <th scope="col">Verdict</th>
                <th scope="col">Since the previous brief</th>
              </tr>
            </thead>
            <tbody>
              {s.runs.map((r) => (
                <tr key={r.day}>
                  <td>
                    <a href={`#/tasks/${r.runId}`}>{r.day}</a>
                  </td>
                  <td>
                    {r.status === null ? (
                      '–'
                    ) : (
                      <Status tone={runTone(r.status)}>{runText(r.status)}</Status>
                    )}
                  </td>
                  <td>{r.verdict === null ? '–' : <VerdictBadge verdict={r.verdict} />}</td>
                  <td>
                    {r.delta === null ? (
                      <span className="hint">
                        {r.status === 'SUCCEEDED' ? 'Nothing to compare with' : '–'}
                      </span>
                    ) : (
                      <span className="delta-cell">
                        {r.delta.added.length} new, {r.delta.gone.length} no longer in the data,{' '}
                        {r.delta.changed.length} priority change
                        {r.delta.changed.length === 1 ? '' : 's'}
                        {r.delta.added.length === 0 ? null : (
                          <span className="cell-sub">New: {r.delta.added.join(', ')}</span>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

export function SchedulePage() {
  const { config, authenticated } = useApp();
  const res = useApi<SchedulesResponse>('/api/schedules', 15_000);
  const [adding, setAdding] = useState(false);
  const defaultBudget =
    BigInt(config.policy.maxPerRun) < 300_000n ? config.policy.maxPerRun : '300000';

  return (
    <>
      <PageHead
        title="Daily brief"
        intro="A brief once a day, with what changed since the last one. Runs on the server."
      />
      {authenticated ? null : <AccessForm purpose="schedule" />}
      {config.mode === 'mock' ? (
        <Notice tone="warn">Mock server: scheduled briefs here use fake networks.</Notice>
      ) : null}
      {config.deployment?.ephemeralDatabase === true ? (
        <Notice tone="info">
          This server&rsquo;s database is wiped when the host restarts, so schedules added here last
          until then.{' '}
          {config.deployment.seededBrief
            ? 'The daily brief listed from the server’s configuration is recreated at every start.'
            : 'A lasting daily brief comes from the server’s configuration (DAILY_BRIEF_*).'}{' '}
          {config.deployment.catchUpWindowMin === null
            ? null
            : `A brief that could not run at its time still starts within ${config.deployment.catchUpWindowMin} minutes after it, not later that day.`}
        </Notice>
      ) : null}
      {config.policy.paymentsPaused ? (
        <Notice tone="warn">
          Payments are paused, so no brief can start. Resume them under{' '}
          <a href="#/rules">Spending rules</a>.
        </Notice>
      ) : null}

      <section aria-labelledby="schedules-title">
        <div className="section-head">
          <h2 id="schedules-title">Schedules</h2>
          {res.data === null || adding || res.data.schedules.length >= res.data.max ? null : (
            <button
              type="button"
              className="button"
              disabled={!authenticated}
              onClick={() => setAdding(true)}
            >
              Add a schedule
            </button>
          )}
        </div>
        {adding ? (
          <div className="panel">
            <h3>New schedule</h3>
            <ScheduleForm
              initial={{ watchlist: '', budget: hbar(defaultBudget), runAfter: '00:15' }}
              submitLabel="Create schedule"
              onCancel={() => setAdding(false)}
              onSave={async (b) => {
                await postJson('/api/schedules', { ...b, enabled: true });
                setAdding(false);
                res.reload();
              }}
            />
          </div>
        ) : null}
        {res.data === null ? (
          res.error === null ? (
            <Loading what="schedules" />
          ) : (
            <ErrorNotice error={res.error} />
          )
        ) : res.data.schedules.length === 0 && !adding ? (
          <Empty title="No schedule yet.">
            <p>
              Add one to brief a watchlist every day. 00:15 UTC is a good time: the 0G daily cap has
              just reset.
            </p>
          </Empty>
        ) : (
          <ul className="run-cards">
            {res.data.schedules.map((s) => (
              <ScheduleCard key={s.id} s={s} reload={res.reload} />
            ))}
          </ul>
        )}
        <Stale error={res.error} updatedAt={res.updatedAt} />
      </section>
    </>
  );
}
