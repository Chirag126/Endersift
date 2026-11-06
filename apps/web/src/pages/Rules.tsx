/**
 * The spending rules (D-052): the kill switch, the owner's limits with their
 * source, what a change would do, and the audit trail. Saving goes to
 * PUT /api/policy; the server validates against its env ceiling and the
 * firewall enforces what is saved. Checks here are a convenience only.
 *
 * The approval switch (D-066) defaults to Autonomous; Human approval makes
 * payments above a threshold wait for the owner on the task page. Per-provider
 * daily caps are enforced by the same firewall.
 *
 * Four layers are named plainly, because only two exist:
 *   draft (this page, not saved) · saved app policy (enforced) ·
 *   ENS-published policy (not built) · on-chain verified (not built)
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../App.tsx';
import { ErrorNotice, Hbar, Loading, Notice, PageHead, Proof, Status } from '../components/ui.tsx';
import { useApi } from '../hooks.tsx';
import { ApiError, putJson } from '../lib/api.ts';
import { hashscanAccount } from '../lib/explorers.ts';
import { hbar, utcTime, zgAmount } from '../lib/format.ts';
import {
  MAX_PROVIDER_CAPS,
  checkDraft,
  draftDirty,
  draftOf,
  policyChanges,
  sameLimits,
  type CapDraft,
  type DraftField,
  type PolicyDraft,
} from '../lib/policy.ts';
import type { OwnerLimits, PolicyResponse, ProvidersResponse } from '../lib/types.ts';
import { AccessForm } from './NewTask.tsx';

interface SaveResult {
  readonly version: number | null;
  readonly confirmed: boolean;
}

type LimitField = 'maxPerPayment' | 'maxPerRun' | 'maxPerDay' | 'maxPaymentsPerRun';

const FIELDS: readonly {
  readonly key: LimitField;
  readonly label: string;
  readonly unit: string;
}[] = [
  { key: 'maxPerPayment', label: 'Per payment', unit: 'HBAR' },
  { key: 'maxPerRun', label: 'Per task', unit: 'HBAR' },
  { key: 'maxPerDay', label: 'Per UTC day, all tasks', unit: 'HBAR' },
  { key: 'maxPaymentsPerRun', label: 'Payments per task', unit: '' },
];

function show(field: LimitField, l: OwnerLimits) {
  return field === 'maxPaymentsPerRun' ? String(l[field]) : <Hbar tinybars={l[field]} />;
}

export function RulesPage() {
  const { config, authenticated, refreshConfig } = useApp();
  const policy = useApi<PolicyResponse>('/api/policy');
  // ENS names to suggest for the per-provider caps (the server checks the name, not this list)
  const known = useApi<ProvidersResponse>('/api/providers');
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);

  // the draft starts from what is in force, and resets when that changes
  const p = policy.data;
  useEffect(() => {
    if (p !== null) setDraft(draftOf(p.effective));
  }, [p]);

  const save = async (limits: OwnerLimits, note: string) => {
    if (p === null) return;
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const res = await putJson<PolicyResponse>('/api/policy', {
        ...limits,
        expectedVersion: p.version,
        reason: note.trim() === '' ? null : note.trim(),
      });
      // confirm by reading back what the server now enforces
      policy.reload();
      refreshConfig();
      setSaved({ version: res.version, confirmed: sameLimits(res.effective, limits) });
      setReason('');
      setConfirmPause(false);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'UNREACHABLE', String(e), null));
      if (e instanceof ApiError && e.code === 'POLICY_CONFLICT') policy.reload();
    } finally {
      setSaving(false);
    }
  };

  if (policy.error !== null && p === null)
    return (
      <>
        <PageHead title="Spending rules" />
        <ErrorNotice error={policy.error} />
      </>
    );
  if (p === null || draft === null)
    return (
      <>
        <PageHead title="Spending rules" />
        <Loading what="the rules" />
      </>
    );

  const check = checkDraft(draft, p.ceiling);
  const changes = check.ok ? policyChanges(p.effective, check.limits) : [];
  const limitChanges = changes.filter((c) => c.field !== 'paymentsPaused');
  const initial = draftOf(p.effective);
  const dirty = draftDirty(draft, initial);
  const paused = p.effective.paymentsPaused;
  const set = (key: Exclude<DraftField, `cap-${number}`>, value: string | boolean) =>
    setDraft((d) => (d === null ? d : { ...d, [key]: value }));
  const setCaps = (f: (caps: readonly CapDraft[]) => readonly CapDraft[]) =>
    setDraft((d) => (d === null ? d : { ...d, caps: f(d.caps) }));
  const errorOf = (key: DraftField) => (check.ok ? undefined : check.errors[key]);
  const human = draft.approvalMode === 'human';
  const providerNames = (known.data?.providers ?? []).map((x) => x.ensName);
  const timeoutMin =
    config.approvals === undefined ? null : Math.round(config.approvals.timeoutSec / 60);
  const approvalsEnforced = p.enforcement.approvals === true;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!check.ok || limitChanges.length === 0 || saving) return;
    void save({ ...check.limits, paymentsPaused: paused }, reason);
  };

  return (
    <>
      <PageHead
        title="Spending rules"
        intro="The server checks every payment against these rules, whatever the model asks for."
      />

      {authenticated ? null : <AccessForm purpose="rules" />}
      {p.serverPaused === true ? (
        <Notice tone="warn">
          Payments are paused by the server&rsquo;s own setting (<code>X402_PAYMENTS_PAUSED</code>).
          Nothing saved here can lift that; the owner changes it in the host&rsquo;s settings.
        </Notice>
      ) : null}
      {config.deployment?.ephemeralDatabase === true ? (
        <Notice tone="info">
          This server&rsquo;s database is wiped when the host restarts (it sleeps after 15 minutes
          without visitors). Rules saved here, the pause included, last until then; afterwards the
          server&rsquo;s configuration applies again. For a pause that lasts, the owner sets{' '}
          <code>X402_PAYMENTS_PAUSED=true</code> in the host&rsquo;s settings.
        </Notice>
      ) : null}

      {saved === null ? null : (
        <Notice tone="info">
          Saved as version {saved.version ?? '?'}.{' '}
          {saved.confirmed
            ? 'Read back from the server: these rules are in force now.'
            : 'The server enforces different values than requested (its ceiling applied); see below.'}
        </Notice>
      )}
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

      <section
        className={`killswitch${paused ? ' killswitch-on' : ''}`}
        aria-labelledby="kill-title"
      >
        <div className="killswitch-state">
          <h2 id="kill-title">{paused ? 'Payments are paused' : 'Payments are allowed'}</h2>
          <p>
            {paused
              ? 'The firewall refuses every payment, including the next one of a task already running. New tasks cannot start.'
              : 'Within the limits below. Pausing takes effect at the next payment, even inside a running task, before anything is signed.'}
          </p>
        </div>
        <div className="killswitch-control">
          {paused ? (
            <button
              type="button"
              className="button button-primary"
              disabled={!authenticated || saving}
              onClick={() => void save({ ...p.effective, paymentsPaused: false }, reason)}
            >
              {saving ? 'Saving…' : 'Resume payments'}
            </button>
          ) : confirmPause ? (
            <div className="confirm" role="group" aria-label="Confirm pausing payments">
              <p>Pause every payment now?</p>
              <button
                type="button"
                className="button button-danger"
                disabled={!authenticated || saving}
                onClick={() => void save({ ...p.effective, paymentsPaused: true }, reason)}
              >
                {saving ? 'Pausing…' : 'Pause payments'}
              </button>
              <button type="button" className="button-quiet" onClick={() => setConfirmPause(false)}>
                Keep them allowed
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button button-danger"
              disabled={!authenticated || saving}
              onClick={() => setConfirmPause(true)}
            >
              Pause all payments
            </button>
          )}
        </div>
      </section>

      <div className="split">
        <section className="split-main" aria-labelledby="limits-title">
          <div className="section-head">
            <h2 id="limits-title">Limits on Hedera payments</h2>
            <span className={`source source-${p.source}`}>
              {p.source === 'owner'
                ? `Owner rules v${p.version ?? '?'}, saved ${p.updatedAt === null ? '' : utcTime(p.updatedAt)}`
                : 'From the server configuration'}
            </span>
          </div>
          {p.reason === null ? null : <p className="hint">Reason given: {p.reason}</p>}
          <p className="mode-line">
            <Status tone={p.effective.approvalMode === 'human' ? 'warn' : 'good'}>
              {p.effective.approvalMode === 'human' ? 'Human approval' : 'Autonomous'}
            </Status>
            <span className="hint">
              {p.effective.approvalMode === 'human'
                ? BigInt(p.effective.approvalAboveTinybars ?? '0') === 0n
                  ? 'In force: every payment waits for your approval.'
                  : `In force: payments above ${hbar(p.effective.approvalAboveTinybars ?? '0')} HBAR wait for your approval.`
                : 'In force: payments within the limits go ahead without asking.'}
            </span>
          </p>
          {p.clamped.length === 0 ? null : (
            <Notice tone="warn">
              The server configuration was lowered after these rules were saved, so{' '}
              {p.clamped.join(', ')} {p.clamped.length === 1 ? 'is' : 'are'} held at the server
              ceiling.
            </Notice>
          )}

          <form className="policy-form" onSubmit={submit} aria-busy={saving}>
            <div className="table-wrap">
              <table className="limits">
                <thead>
                  <tr>
                    <th scope="col">Limit</th>
                    <th scope="col">In force</th>
                    <th scope="col">Server ceiling</th>
                    <th scope="col">New value</th>
                  </tr>
                </thead>
                <tbody>
                  {FIELDS.map((f) => {
                    const err = check.ok ? undefined : check.errors[f.key];
                    const id = `limit-${f.key}`;
                    return (
                      <tr key={f.key}>
                        <th scope="row">
                          <label htmlFor={id}>{f.label}</label>
                        </th>
                        <td>{show(f.key, p.effective)}</td>
                        <td className="hint">{show(f.key, p.ceiling)}</td>
                        <td>
                          <div className="limit-input">
                            <input
                              id={id}
                              inputMode={f.key === 'maxPaymentsPerRun' ? 'numeric' : 'decimal'}
                              value={draft[f.key]}
                              onChange={(e) => set(f.key, e.target.value)}
                              aria-invalid={err !== undefined}
                              aria-describedby={err === undefined ? undefined : `${id}-error`}
                              disabled={!authenticated}
                            />
                            {f.unit === '' ? null : <span className="unit-label">{f.unit}</span>}
                          </div>
                          {err === undefined ? null : (
                            <p className="field-error" id={`${id}-error`}>
                              {err}
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <fieldset className="approval-mode" disabled={!authenticated || !approvalsEnforced}>
              <legend>Who approves each payment</legend>
              {approvalsEnforced ? null : (
                <p className="hint">This server does not support human approval yet.</p>
              )}
              <div className="segmented" role="radiogroup" aria-label="Approval mode">
                <label className={`segment${human ? '' : ' segment-on'}`}>
                  <input
                    type="radio"
                    name="approval-mode"
                    value="autonomous"
                    checked={!human}
                    onChange={() => set('approvalMode', 'autonomous')}
                  />
                  <span className="segment-title">Autonomous</span>
                  <span className="segment-hint">
                    The default. The firewall decides alone; nothing waits for you.
                  </span>
                </label>
                <label className={`segment${human ? ' segment-on' : ''}`}>
                  <input
                    type="radio"
                    name="approval-mode"
                    value="human"
                    checked={human}
                    onChange={() => set('approvalMode', 'human')}
                  />
                  <span className="segment-title">Human approval</span>
                  <span className="segment-hint">
                    Payments the firewall allows still wait for your yes before they are signed.
                  </span>
                </label>
              </div>
              {human ? (
                <div className="approval-threshold">
                  <label htmlFor="approval-above">Ask when a payment is more than</label>
                  <div className="limit-input">
                    <input
                      id="approval-above"
                      inputMode="decimal"
                      value={draft.approvalAbove}
                      onChange={(e) => set('approvalAbove', e.target.value)}
                      aria-invalid={errorOf('approvalAbove') !== undefined}
                      aria-describedby="approval-above-help"
                    />
                    <span className="unit-label">HBAR</span>
                  </div>
                  <p className="hint" id="approval-above-help">
                    {errorOf('approvalAbove') ?? (
                      <>
                        0 asks for every payment. A request you do not answer
                        {timeoutMin === null ? '' : ` within ${timeoutMin} minutes`} expires, and
                        the payment is not made. Approving never lifts a limit: the firewall checks
                        again before signing.
                      </>
                    )}
                  </p>
                </div>
              ) : null}
            </fieldset>

            <fieldset className="provider-caps" disabled={!authenticated}>
              <legend>Daily cap per provider</legend>
              <p className="hint">
                Optional. Limits what all tasks together pay one provider per UTC day, inside the
                overall daily limit. Providers without a row have no extra cap.
              </p>
              {draft.caps.length === 0 ? null : (
                <ul className="cap-rows">
                  {draft.caps.map((row, i) => {
                    const err = errorOf(`cap-${i}`);
                    const id = `cap-${i}`;
                    return (
                      <li key={i}>
                        <div className="cap-row">
                          <label className="sr-only" htmlFor={`${id}-name`}>
                            Provider ENS name, row {i + 1}
                          </label>
                          <input
                            id={`${id}-name`}
                            list="provider-names"
                            placeholder="kev.example.eth"
                            value={row.name}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(e) =>
                              setCaps((c) =>
                                c.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                              )
                            }
                            aria-invalid={err !== undefined}
                            aria-describedby={err === undefined ? undefined : `${id}-error`}
                          />
                          <div className="limit-input">
                            <label className="sr-only" htmlFor={`${id}-amount`}>
                              Daily cap in HBAR, row {i + 1}
                            </label>
                            <input
                              id={`${id}-amount`}
                              inputMode="decimal"
                              value={row.amount}
                              onChange={(e) =>
                                setCaps((c) =>
                                  c.map((r, j) => (j === i ? { ...r, amount: e.target.value } : r)),
                                )
                              }
                              aria-invalid={err !== undefined}
                            />
                            <span className="unit-label">HBAR</span>
                          </div>
                          <button
                            type="button"
                            className="button-quiet"
                            onClick={() => setCaps((c) => c.filter((_, j) => j !== i))}
                          >
                            Remove
                          </button>
                        </div>
                        {err === undefined ? null : (
                          <p className="field-error" id={`${id}-error`}>
                            {err}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <datalist id="provider-names">
                {providerNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <button
                type="button"
                className="button-quiet"
                disabled={draft.caps.length >= MAX_PROVIDER_CAPS}
                onClick={() => setCaps((c) => [...c, { name: '', amount: '' }])}
              >
                Add a provider cap
              </button>
            </fieldset>

            {!dirty ? (
              <p className="hint">
                {authenticated
                  ? 'Change a value to see what it would do. Nothing is saved until you save.'
                  : 'Unlock changes to edit the limits.'}
              </p>
            ) : (
              <div className="changes" aria-live="polite">
                <h3>If you save</h3>
                {!check.ok ? (
                  <p className="hint">Fix the marked values to see what saving would do.</p>
                ) : limitChanges.length === 0 ? (
                  <p className="hint">These are the values already in force.</p>
                ) : (
                  <ul>
                    {limitChanges.map((c) => (
                      <li key={`${c.field}-${c.label}`}>
                        <span className="change-what">
                          {c.label}: {c.from} to {c.to}
                        </span>
                        <span className="hint">{c.effect}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <label htmlFor="policy-reason">Reason (kept in the history, optional)</label>
                <input
                  id="policy-reason"
                  value={reason}
                  maxLength={200}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="row">
                  <button
                    type="submit"
                    className="button button-primary"
                    disabled={!authenticated || !check.ok || limitChanges.length === 0 || saving}
                  >
                    {saving ? 'Saving…' : 'Save rules'}
                  </button>
                  <button
                    type="button"
                    className="button-quiet"
                    onClick={() => setDraft(draftOf(p.effective))}
                  >
                    Discard changes
                  </button>
                </div>
              </div>
            )}
          </form>

          <h2>Where these rules live</h2>
          <ul className="layers">
            <li>
              <Status tone={dirty ? 'warn' : 'neutral'}>
                {dirty ? 'Unsaved edits' : 'No unsaved edits'}
              </Status>
              <span>On this page only, until saved. Not enforced.</span>
            </li>
            <li>
              <Status tone="good">Enforced</Status>
              <span>
                Saved app rules, in the agent’s database. The firewall reads them before every
                payment; the server’s configuration is the ceiling they can never exceed.
              </span>
            </li>
            <li>
              <Status tone="neutral">Not built</Status>
              <span>
                Rules published to ENS records. The agent does not publish or read its policy on
                ENS.
              </span>
            </li>
            <li>
              <Status tone="neutral">Not built</Status>
              <span>
                On-chain verification of the policy. Nothing on chain checks these limits.
              </span>
            </li>
          </ul>

          <h2>How each payment is decided</h2>
          <ol className="steps">
            <li>The provider asks for payment with HTTP 402 and names a price and a payee.</li>
            <li>
              The firewall checks the kill switch, then the quote against the provider’s ENS records
              and the limits above, including any daily cap for that provider.
            </li>
            <li>
              In Human approval mode, a payment above the threshold waits for your answer on the
              task page. On a yes the quote is fetched again; it is signed only if it is unchanged
              and payments are still allowed.
            </li>
            <li>
              Only that exact quote is signed. The transaction ID is saved before the request is
              sent.
            </li>
            <li>
              The payment counts as settled only when Hedera’s Mirror Node shows the payee received
              exactly that amount.
            </li>
            <li>
              A payment whose outcome is unknown is never paid again; it is resolved from the Mirror
              Node later.
            </li>
          </ol>
        </section>

        <aside className="split-side">
          <h2>Fixed by the server</h2>
          <p className="hint">Set in the server configuration; not editable here.</p>
          <ul className="rules">
            <li>Asset: HBAR only (Hedera {config.networks.hedera}).</li>
            <li>
              Paying account{' '}
              <Proof
                value={p.fixed.payer}
                href={hashscanAccount(config.networks.hedera, p.fixed.payer)}
                label="payer account"
                full
              />
            </li>
            <li>Only providers found on ENS, at their ENS price and payee.</li>
            <li>
              {p.fixed.allowedProviders === null
                ? 'Any provider discovered on ENS.'
                : `Only: ${p.fixed.allowedProviders.join(', ')}.`}
            </li>
            <li>
              The ENS reading must be at most {Math.round(p.fixed.maxSnapshotAgeSec / 60)} minutes
              old.
            </li>
          </ul>
          <h2>0G inference</h2>
          <ul className="rules">
            <li>
              Model <code>{config.zg.model}</code> on 0G {config.networks.zg}.
            </li>
            <li>At most {zgAmount(config.zg.capNeuron)} per call, reserved before sending.</li>
            <li>At most {zgAmount(config.zg.dailyCapNeuron)} per UTC day.</li>
            <li>No call is ever retried automatically.</li>
          </ul>

          <h2>History</h2>
          {p.history.length === 0 ? (
            <p className="hint">No changes saved. The server configuration is in force.</p>
          ) : (
            <ol className="history-list">
              {p.history.map((v) => (
                <li key={v.version}>
                  <p>
                    <strong>v{v.version}</strong> {utcTime(v.createdAt)}
                  </p>
                  <p className="hint">
                    {v.paymentsPaused ? 'Paused. ' : ''}Task <Hbar tinybars={v.maxPerRun} />,
                    payment <Hbar tinybars={v.maxPerPayment} />, day <Hbar tinybars={v.maxPerDay} />
                    , {v.maxPaymentsPerRun} payments per task.
                    {v.approvalMode !== 'human'
                      ? ''
                      : BigInt(v.approvalAboveTinybars ?? '0') === 0n
                        ? ' Human approval for every payment.'
                        : ` Human approval above ${hbar(v.approvalAboveTinybars ?? '0')} HBAR.`}
                    {Object.keys(v.providerDailyCaps ?? {}).length === 0
                      ? ''
                      : ` ${Object.keys(v.providerDailyCaps ?? {}).length} provider cap(s).`}
                    {v.reason === null ? '' : ` “${v.reason}”`}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
    </>
  );
}
