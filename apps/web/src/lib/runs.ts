/**
 * Words for run stages, outcomes and verdicts. The verdict itself comes from
 * the server (GET /api/runs, D-053); the UI only labels it. Pure.
 */
import type { Tone } from './timeline.ts';
import type { Severity, Stage, StageOutcome, Verdict } from './types.ts';

export const STAGE_TEXT: Readonly<Record<Stage, string>> = {
  discovery: 'ENS discovery',
  catalogs: 'Catalogs',
  plan: '0G plan',
  payments: 'x402 payments',
  verification: 'Mirror Node check',
  analysis: '0G analysis',
  report: 'Brief',
};

export const OUTCOME_TEXT: Readonly<Record<StageOutcome, string>> = {
  done: 'Done',
  partial: 'Partly done',
  failed: 'Failed',
  skipped: 'Not needed',
  running: 'In progress',
  'not-reached': 'Not reached',
};

export const outcomeTone = (o: StageOutcome): Tone =>
  o === 'done'
    ? 'good'
    : o === 'failed'
      ? 'bad'
      : o === 'partial' || o === 'running'
        ? 'warn'
        : 'neutral';

export const VERDICT_TEXT: Readonly<Record<Verdict, string>> = {
  'e2e-verified': 'End-to-end verified',
  'completed-with-gaps': 'Finished, not fully verified',
  failed: 'Failed, not verified',
  'in-progress': 'Running',
  mock: 'Mock run, not verification',
};

export const verdictTone = (v: Verdict): Tone =>
  v === 'e2e-verified' ? 'good' : v === 'failed' ? 'bad' : v === 'mock' ? 'neutral' : 'warn';

export const SEVERITY_TEXT: Readonly<Record<Severity, string>> = {
  info: 'Info',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
};

export const severityTone = (s: Severity): Tone =>
  s === 'success' ? 'good' : s === 'error' ? 'bad' : s === 'warning' ? 'warn' : 'neutral';

const ORIGIN_TEXT: Readonly<Record<string, string>> = {
  api: 'Started from the web app',
  cli: 'Started from the command line',
  scheduler: 'Started by the daily schedule',
};
export const originText = (o: string | null): string =>
  o === null ? 'Origin not recorded' : (ORIGIN_TEXT[o] ?? o);

/** How long a finished task's page keeps asking for its HCS audit rows, and how often (D-086). */
export const AUDIT_REFRESH_MS = 3_000;
export const AUDIT_REFRESH_FOR_MS = 120_000;

/**
 * Is a finished task's HCS audit still settling (D-086)? The server posts the
 * messages after the run ends, with no new run event, so the page must ask
 * again: until the task digest is recorded and no message is still being
 * submitted or waiting for the Mirror Node.
 */
export function auditSettling(
  audit: readonly { readonly kind: string; readonly status: string }[],
  hcsOn: boolean,
): boolean {
  if (!hcsOn) return false;
  if (!audit.some((m) => m.kind === 'task')) return true;
  return audit.some((m) => m.status === 'SUBMITTING' || m.status === 'SUBMITTED');
}
