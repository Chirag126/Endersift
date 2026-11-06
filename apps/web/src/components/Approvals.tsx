/**
 * Human approval (D-066): a payment the firewall allowed, waiting for the
 * owner's yes or no before anything is signed. The server decides what needs
 * approval and enforces the answer; this prompt only sends it. The countdown
 * is computed from the request's own expiry time, never simulated.
 */
import { useEffect, useState } from 'react';
import { useApp } from '../App.tsx';
import { ApiError, postJson } from '../lib/api.ts';
import { countdownText, secondsLeft } from '../lib/approvals.ts';
import { hashscanAccount } from '../lib/explorers.ts';
import { hbar } from '../lib/format.ts';
import type { PaymentApproval } from '../lib/types.ts';
import { AccessForm } from '../pages/NewTask.tsx';
import { Hbar, Proof, Status } from './ui.tsx';

const STATUS_TEXT: Readonly<Record<PaymentApproval['status'], string>> = {
  PENDING: 'Waiting for you',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
};

export const approvalTone = (s: PaymentApproval['status']) =>
  s === 'APPROVED' ? 'good' : s === 'PENDING' ? 'warn' : s === 'REJECTED' ? 'bad' : 'neutral';

/** One approval's state in a word, with who decided. */
export function ApprovalState({ approval }: { approval: PaymentApproval }) {
  const by =
    approval.decidedBy === 'timeout'
      ? ' (no answer in time)'
      : approval.decidedBy === 'restart'
        ? ' (server restarted)'
        : '';
  return (
    <Status tone={approvalTone(approval.status)}>
      {STATUS_TEXT[approval.status]}
      {by}
    </Status>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** The yes/no prompt for one PENDING request. `onDecided` reloads the caller's data. */
export function ApprovalPrompt({
  approval,
  onDecided,
}: {
  approval: PaymentApproval;
  onDecided: () => void;
}) {
  const { config, authenticated } = useApp();
  const now = useNow(approval.status === 'PENDING');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const left = secondsLeft(approval.expiresAt, now);
  const expired = left === 0;
  const titleId = `approval-${approval.id}`;

  const decide = async (decision: 'approve' | 'reject') => {
    if (busy !== null) return;
    setBusy(decision);
    setError(null);
    try {
      await postJson(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        decision,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The answer could not be sent.');
    } finally {
      setBusy(null);
      onDecided();
    }
  };

  return (
    <section className="approval-prompt" aria-labelledby={titleId} role="group">
      <header className="approval-head">
        <h3 id={titleId}>
          Approve {hbar(approval.amountAtomic)} HBAR to {approval.provider}?
        </h3>
        <span className="approval-clock" aria-live="off">
          {expired ? 'Expiring…' : `Expires in ${countdownText(left)}`}
        </span>
      </header>
      <dl className="facts">
        <dt>Amount</dt>
        <dd>
          <Hbar tinybars={approval.amountAtomic} />
        </dd>
        <dt>Provider</dt>
        <dd>
          {approval.provider} <span className="hint">({approval.capability})</span>
        </dd>
        <dt>Paid to</dt>
        <dd>
          <Proof
            value={approval.payTo}
            href={hashscanAccount(config.networks.hedera, approval.payTo)}
            label="payee account"
            full
          />
        </dd>
        <dt>Why you are asked</dt>
        <dd>
          {BigInt(approval.threshold) === 0n
            ? 'Human approval is on for every payment.'
            : `It is above your approval threshold of ${hbar(approval.threshold)} HBAR.`}{' '}
          The firewall already checked it against the limits and ENS.
        </dd>
      </dl>
      <details className="tech">
        <summary>Technical details</summary>
        <dl className="facts">
          <dt>Request</dt>
          <dd>
            <code className="wrap">{approval.requestUrl}</code>
          </dd>
          <dt>Approval ID</dt>
          <dd>
            <Proof value={approval.id} label="approval ID" />
          </dd>
          <dt>Payment ID</dt>
          <dd>
            <Proof value={approval.paymentId} label="payment ID" />
          </dd>
          <dt>Asked</dt>
          <dd>{approval.requestedAt}</dd>
        </dl>
      </details>
      {!authenticated ? (
        <AccessForm purpose="approve" />
      ) : (
        <div className="approval-actions">
          <label className="sr-only" htmlFor={`${titleId}-note`}>
            Note (optional, kept with the decision)
          </label>
          <input
            id={`${titleId}-note`}
            placeholder="Note (optional)"
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            type="button"
            className="button button-primary"
            disabled={busy !== null || expired}
            onClick={() => void decide('approve')}
          >
            {busy === 'approve' ? 'Approving…' : 'Approve payment'}
          </button>
          <button
            type="button"
            className="button button-danger"
            disabled={busy !== null || expired}
            onClick={() => void decide('reject')}
          >
            {busy === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      )}
      <p className="hint">
        On approval the agent asks the provider for its quote again and signs only if it is
        unchanged and payments are still allowed.
      </p>
      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
