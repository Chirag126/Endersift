/**
 * Start a task: the watchlist (typed, or said and transcribed on 0G, D-076),
 * this task's budget (the one part of the spending policy a person sets per
 * task; it can only lower the configured limit), and the access code that
 * unlocks spending.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../App.tsx';
import { Hbar, Notice, PageHead, Proof, Status } from '../components/ui.tsx';
import { VoiceInput, type VoiceResult } from '../components/VoiceInput.tsx';
import { navigate, useApi } from '../hooks.tsx';
import { ApiError, postJson } from '../lib/api.ts';
import { hbar, zgAmount } from '../lib/format.ts';
import { checkBudget, ruleSentences } from '../lib/policy.ts';
import type { Health, Task } from '../lib/types.ts';
import { spokenToWatchlist, voiceReceipt } from '../lib/voice.ts';

export const ACCESS_PURPOSES = ['spending', 'rules', 'schedule', 'approve'] as const;
type AccessPurpose = (typeof ACCESS_PURPOSES)[number];

const EXAMPLE = 'OpenSSL\nlodash@4.17.20 (npm)\nMicrosoft Windows';

function watchlistItems(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,;]/)
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    ),
  ];
}

export function AccessForm({ purpose = 'spending' }: { purpose?: AccessPurpose }) {
  const { refreshSession } = useApp();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || code.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await postJson('/api/session', { code: code.trim() });
      setCode('');
      refreshSession();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The code could not be checked.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="access" onSubmit={(e) => void submit(e)}>
      <h2>
        {purpose === 'spending'
          ? 'Unlock spending'
          : purpose === 'approve'
            ? 'Unlock approvals'
            : 'Unlock changes'}
      </h2>
      <p>
        {purpose === 'rules'
          ? 'Changing the spending rules needs the access code set on the server ('
          : purpose === 'approve'
            ? 'Approving or rejecting a payment needs the access code set on the server ('
            : purpose === 'schedule'
              ? 'A schedule spends funds every day, so changing it needs the access code set on the server ('
              : 'Starting a task spends funds, so it needs the access code set on the server ('}
        <code>DEMO_ACCESS_CODE</code>). It is checked once; this browser then keeps a session for 12
        hours.
      </p>
      <label htmlFor="access-code">Access code</label>
      <div className="row">
        <input
          id="access-code"
          type="password"
          autoComplete="current-password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : 'access-error'}
        />
        <button type="submit" className="button" disabled={busy || code.trim() === ''}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </div>
      {error === null ? null : (
        <p id="access-error" className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function NewTaskPage() {
  const { config, authenticated, providerHost } = useApp();
  const defaultBudget =
    BigInt(config.policy.maxPerRun) < 300_000n ? config.policy.maxPerRun : '300000';
  const [watchlist, setWatchlist] = useState('');
  const [budget, setBudget] = useState(hbar(defaultBudget));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the 0G transcription that filled the watchlist; it joins the task's run
  const [voice, setVoice] = useState<VoiceResult | null>(null);
  const voiceOn = config.voice?.enabled === true;
  // a task already running stays one click away when the owner comes back here (D-084)
  const health = useApi<Health>('/api/health', 5_000);
  const runningId = health.data?.queue.running ?? null;
  const queued = health.data?.queue.pending ?? 0;

  const items = watchlistItems(watchlist);
  const check = checkBudget(budget, config);
  const watchlistProblem =
    items.length === 0
      ? 'Add at least one product, package or vendor.'
      : items.length > 20
        ? 'At most 20 items.'
        : items.some((i) => i.length > 100)
          ? 'Each item can be at most 100 characters.'
          : null;
  const ready = authenticated && check.ok && watchlistProblem === null && !submitting;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !check.ok) return;
    setSubmitting(true); // also blocks a second click while the request is in flight
    setError(null);
    try {
      const res = await postJson<{ task: Task }>('/api/tasks', {
        watchlist: items,
        budget: check.tinybars.toString(),
        ...(voice === null ? {} : { voiceCallId: voice.call.id }),
      });
      navigate(`/tasks/${res.task.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The task could not be started.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHead title="New task" intro="What to watch and how much the agent may spend." />
      <div className="split">
        <div className="split-main">
          {config.policy.paymentsPaused ? (
            <Notice tone="warn">
              Payments are paused (kill switch), so no task can start. Resume them under{' '}
              <a href="#/rules">Spending rules</a>.
            </Notice>
          ) : null}
          {typeof config.zg.unavailable === 'string' ? (
            <Notice tone="warn">
              0G inference was unavailable when this server started: {config.zg.unavailable}. A task
              still finds providers on ENS and reads their catalogs, then stops at the 0G plan step
              with nothing paid. The server checks 0G again at most once a minute.
            </Notice>
          ) : null}
          {providerHost === 'waking' ? (
            <Notice tone="info">
              Waking the provider host from this browser (Render free sleeps after 15 minutes). It
              takes about a minute; a task started now waits for it.
            </Notice>
          ) : providerHost === 'unreachable' ? (
            <Notice tone="warn">
              The provider host is not answering this browser. A task started now will probably stop
              at the catalog step, with nothing paid.
            </Notice>
          ) : null}
          {runningId === null ? null : (
            <Notice tone="info">
              <span>
                A task is running now
                {queued > 0 ? `, with ${queued} more waiting` : ''}.{' '}
                <a href={`#/tasks/${encodeURIComponent(runningId)}`}>Open its live page</a>. A new
                task starts after it.
              </span>
            </Notice>
          )}
          {authenticated ? null : <AccessForm />}
          <form className="composer" onSubmit={(e) => void submit(e)} aria-busy={submitting}>
            <label htmlFor="watchlist">What should the agent watch?</label>
            <p className="hint" id="watchlist-hint">
              One per line: products, packages (with version and ecosystem) or vendors.
              {voiceOn ? ' Or say them: 0G’s speech model writes them down for you to check.' : ''}
            </p>
            {
              voiceOn ? (
                <VoiceInput
                  disabled={!authenticated || submitting}
                  onResult={(r) => {
                    setVoice(r);
                    setWatchlist(spokenToWatchlist(r.text));
                  }}
                />
              ) : null /* voice off: nothing is shown (D-089); the reason is in the server log */
            }
            {voiceOn && !authenticated ? (
              <p className="hint">
                Unlock spending to use your voice: each clip is a paid 0G call.
              </p>
            ) : null}
            {voice === null ? null : (
              <div className="voice-receipt" aria-live="polite">
                <div className="side-row">
                  <Status tone={voiceReceipt(voice.call).tone}>
                    {voiceReceipt(voice.call).headline}
                  </Status>
                  <button
                    type="button"
                    className="button-quiet"
                    onClick={() => setVoice(null)}
                    title="Start this task without the voice transcription"
                  >
                    Not from voice
                  </button>
                </div>
                <p className="hint">“{voice.text === '' ? '(nothing heard)' : voice.text}”</p>
                <p className="hint">{voiceReceipt(voice.call).detail}</p>
                {voice.call.requestId === null ? null : (
                  <Proof value={voice.call.requestId} label="0G request ID" />
                )}
              </div>
            )}
            <textarea
              id="watchlist"
              rows={5}
              placeholder={EXAMPLE}
              value={watchlist}
              onChange={(e) => setWatchlist(e.target.value)}
              aria-describedby="watchlist-hint"
            />
            {watchlist !== '' && watchlistProblem !== null ? (
              <p className="field-error">{watchlistProblem}</p>
            ) : null}

            <label htmlFor="budget">Budget for this task</label>
            <p className="hint" id="budget-hint">
              In HBAR. At most <Hbar tinybars={config.policy.maxPerRun} />, the per-task limit in
              force.
            </p>
            <div className="row budget-row">
              <input
                id="budget"
                inputMode="decimal"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                aria-invalid={!check.ok}
                aria-describedby="budget-hint"
              />
              <span className="unit-label">HBAR</span>
              {check.ok ? <span className="hint">{check.tinybars.toString()} tinybars</span> : null}
            </div>
            {check.ok ? null : <p className="field-error">{check.message}</p>}

            <Notice tone="warn">
              Starting this task spends real funds: up to{' '}
              {check.ok ? <Hbar tinybars={check.tinybars} /> : 'your budget'} on Hedera{' '}
              {config.networks.hedera}, and 0G inference on 0G {config.networks.zg} (at most{' '}
              {zgAmount(config.zg.capNeuron)} per call).
            </Notice>
            {error === null ? null : (
              <p className="field-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="button button-primary" disabled={!ready}>
              {submitting ? 'Starting…' : authenticated ? 'Start task' : 'Unlock spending first'}
            </button>
          </form>
        </div>
        <aside className="split-side">
          <h2>Rules for this task</h2>
          <p className="hint">
            The firewall checks every payment against these, whatever the model asks for.
          </p>
          <ul className="rules">
            {ruleSentences(config, check.ok ? check.tinybars : null).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="hint">
            0G: model <code>{config.zg.model}</code>, at most {zgAmount(config.zg.capNeuron)} per
            call and {zgAmount(config.zg.dailyCapNeuron)} per UTC day.{' '}
            <a href="#/rules">All spending rules</a>
          </p>
        </aside>
      </div>
    </>
  );
}
