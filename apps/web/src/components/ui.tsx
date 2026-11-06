/** Small shared pieces: status labels, proofs, money, meters, notices, the stage track, drawers. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../hooks.tsx';
import type { ApiError } from '../lib/api.ts';
import { safeHref } from '../lib/explorers.ts';
import { hbar, middle, percentOf } from '../lib/format.ts';
import { OUTCOME_TEXT, STAGE_TEXT, VERDICT_TEXT, outcomeTone, verdictTone } from '../lib/runs.ts';
import type { Tone } from '../lib/timeline.ts';
import type { AuditInfo, StageResult, Verdict } from '../lib/types.ts';

/** A status with a shape as well as a colour (never colour alone). */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-mark" aria-hidden="true" />
      {children}
    </span>
  );
}

export const paymentTone = (status: string): Tone =>
  status === 'SETTLED'
    ? 'good'
    : status === 'REFUSED' || status === 'FAILED'
      ? 'bad'
      : status === 'UNKNOWN' || status === 'SUBMITTED' || status === 'SIGNED'
        ? 'warn'
        : 'neutral';

export const runTone = (status: string): Tone =>
  status === 'SUCCEEDED'
    ? 'good'
    : status === 'FAILED' || status === 'CANCELLED'
      ? 'bad'
      : status === 'RUNNING'
        ? 'warn'
        : 'neutral';

const RUN_TEXT: Readonly<Record<string, string>> = {
  QUEUED: 'Waiting',
  RUNNING: 'Running',
  SUCCEEDED: 'Finished',
  FAILED: 'Stopped',
  CANCELLED: 'Cancelled',
};
export const runText = (status: string): string => RUN_TEXT[status] ?? status;

const PAYMENT_TEXT: Readonly<Record<string, string>> = {
  CREATED: 'Created',
  AUTHORIZED: 'Approved',
  REFUSED: 'Refused',
  SIGNED: 'Signed',
  SUBMITTED: 'Sent',
  SETTLED: 'Settled',
  UNKNOWN: 'Outcome unknown',
  FAILED: 'Failed',
};
export const paymentText = (status: string): string => PAYMENT_TEXT[status] ?? status;

/** A machine identifier: shortened when long, copyable, linked when it has a public page. */
export function Proof({
  value,
  href,
  label,
  full = false,
}: {
  value: string;
  href?: string | null;
  label: string;
  full?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const shown = full ? value : middle(value, 12);
  const link = safeHref(href);
  return (
    <span className="proof">
      {link !== null ? (
        <a
          className="proof-id"
          href={link}
          target="_blank"
          rel="noreferrer noopener"
          title={`${label}: ${value}`}
        >
          {shown}
        </a>
      ) : (
        <code className="proof-id" title={`${label}: ${value}`}>
          {shown}
        </code>
      )}
      <button
        type="button"
        className="proof-copy"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void copyText(value).then((ok) => {
            setCopied(ok);
            if (ok) window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

/** An HBAR amount with its exact tinybars. */
export function Hbar({ tinybars }: { tinybars: string | bigint }) {
  const t = typeof tinybars === 'bigint' ? tinybars.toString() : tinybars;
  return (
    <span className="money" title={`${t} tinybars`}>
      {hbar(t)} <span className="unit">HBAR</span>
    </span>
  );
}

/** Used of a limit, as a bar with the numbers spelled out. */
export function Meter({
  used,
  limit,
  label,
  format,
}: {
  used: string;
  limit: string;
  label: string;
  format: (v: string) => string;
}) {
  const pct = percentOf(used, limit) ?? 0;
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-figures">
          {format(used)} of {format(limit)}
        </span>
      </div>
      <div
        className={`meter-track${pct >= 90 ? ' meter-high' : ''}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ErrorNotice({ error, action }: { error: ApiError; action?: ReactNode }) {
  return (
    <div className="notice notice-bad" role="alert">
      <p>{error.message}</p>
      {action}
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'warn' | 'info'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="loading" aria-live="polite">
      Loading {what}…
    </p>
  );
}

export function PageHead({
  title,
  intro,
  aside,
  kicker,
  hero = false,
}: {
  title: string;
  intro?: ReactNode;
  aside?: ReactNode;
  /** A short label above the title, shown by the Electric and EnderPay themes. */
  kicker?: string;
  /** The page's main heading set large (the Electric Overview). */
  hero?: boolean;
}) {
  return (
    <header className={`page-head${hero ? ' page-head-hero' : ''}`}>
      <div>
        {kicker === undefined ? null : (
          <p className="kicker theme-extra" aria-hidden="true">
            {kicker}
          </p>
        )}
        <h1>{title}</h1>
        {intro === undefined ? null : <p className="page-intro">{intro}</p>}
      </div>
      {aside}
    </header>
  );
}

/** The server's verdict on a run, never computed here. */
export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <Status tone={verdictTone(verdict)}>{VERDICT_TEXT[verdict]}</Status>;
}

/**
 * A run's seven stages as one connected track: each segment carries its
 * outcome as a shape and a word (screen readers get the list), in order.
 */
export function StageTrack({
  stages,
  compact = false,
}: {
  stages: readonly StageResult[];
  compact?: boolean;
}) {
  return (
    <ol className={`track${compact ? ' track-compact' : ''}`} aria-label="Stages">
      {stages.map((s) => (
        <li
          key={s.stage}
          className={`track-stage track-${s.outcome} tone-${outcomeTone(s.outcome)}`}
          title={`${STAGE_TEXT[s.stage]}: ${OUTCOME_TEXT[s.outcome]}. ${s.detail}`}
        >
          <span className="track-mark" aria-hidden="true" />
          <span className="track-name">{STAGE_TEXT[s.stage]}</span>
          <span className={compact ? 'visually-hidden' : 'track-outcome'}>
            {compact ? `: ${OUTCOME_TEXT[s.outcome]}` : OUTCOME_TEXT[s.outcome]}
          </span>
          {compact ? null : <span className="track-detail">{s.detail}</span>}
        </li>
      ))}
    </ol>
  );
}

/** A side panel for details (native dialog: focus is trapped, Escape closes). */
export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // a click on the backdrop
      }}
    >
      <div className="drawer-body">
        <header className="drawer-head">
          <h2>{title}</h2>
          <button type="button" className="button-quiet" onClick={onClose}>
            Close
          </button>
        </header>
        {open ? children : null}
      </div>
    </dialog>
  );
}

/** Raw JSON as recorded (the server has already redacted secrets), copyable. */
export function JsonBlock({ value, label }: { value: unknown; label: string }) {
  const text = JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <div className="json">
      <button
        type="button"
        className="proof-copy json-copy"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void copyText(text).then((ok) => {
            setCopied(ok);
            if (ok) window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy JSON'}
      </button>
      <pre tabIndex={0} aria-label={label}>
        {text}
      </pre>
    </div>
  );
}

/**
 * Says when polled data could not be refreshed, so old figures are never
 * shown as current. Renders nothing while the data is fresh.
 */
export function Stale({ error, updatedAt }: { error: ApiError | null; updatedAt: number | null }) {
  if (error === null || updatedAt === null) return null;
  return (
    <p className="stale" role="status">
      Could not refresh: {error.message} Showing data from{' '}
      {new Date(updatedAt).toLocaleTimeString()}.
    </p>
  );
}

const AUDIT_TEXT: Readonly<Record<AuditInfo['status'], string>> = {
  CONFIRMED: 'On the Mirror Node',
  SUBMITTED: 'Submitted, not yet on the Mirror Node',
  SUBMITTING: 'Outcome unknown',
  UNKNOWN: 'Outcome unknown',
  FAILED: 'Not posted',
};
const auditTone = (s: AuditInfo['status']): Tone =>
  s === 'CONFIRMED' ? 'good' : s === 'FAILED' ? 'bad' : 'warn';

/** A run's HCS audit messages: what each is, whether the Mirror Node has it, and its transaction. */
export function AuditList({ audit }: { audit: readonly AuditInfo[] }) {
  return (
    <ul className="side-list">
      {audit.map((a) => (
        <li key={a.transactionId}>
          <div className="side-row">
            <span>{a.kind === 'task' ? 'Task digest' : 'Settlement'}</span>
            <span className="hint">{a.sequenceNumber === null ? '' : `#${a.sequenceNumber}`}</span>
          </div>
          <Status tone={auditTone(a.status)}>{AUDIT_TEXT[a.status]}</Status>
          <Proof value={a.transactionId} href={a.hashscan} label="HCS message transaction" />
        </li>
      ))}
    </ul>
  );
}
