/**
 * What one recorded run proves (D-053): its stages, each with an outcome
 * derived only from the run's append-only events, and a verdict. The server
 * decides the verdict so the UI cannot promote a run: a failed run, a mock
 * run or a run with an unresolved payment is never "end-to-end verified".
 *
 * Stages (only the ones the orchestrator has):
 *   discovery     ENS (pinned block)            PROVIDERS_DISCOVERED
 *   catalogs      free provider descriptions     CATALOG_READ
 *   plan          0G PLAN                        INFERENCE_CALLED(PLAN), PLAN_CREATED
 *   payments      firewall + x402                PAYMENT_* , PURCHASE_SKIPPED
 *   verification  Mirror Node settlement         PAYMENT_SETTLED (a DB trigger requires a
 *                                                Mirror Node verification for SETTLED)
 *   analysis      0G ANALYZE                     ANALYSIS_COMPLETED (skipped, with a gap, when
 *                                                no ANALYZE call was made: nothing to analyse)
 *   report        the brief                      REPORT_WRITTEN
 * Pure.
 */

export const STAGES = [
  'discovery',
  'catalogs',
  'plan',
  'payments',
  'verification',
  'analysis',
  'report',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_OUTCOMES = [
  'done',
  'partial',
  'failed',
  'skipped',
  'running',
  'not-reached',
] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export const VERDICTS = [
  'e2e-verified',
  'completed-with-gaps',
  'failed',
  'in-progress',
  'mock',
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const SEVERITIES = ['info', 'success', 'warning', 'error'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface StageResult {
  readonly stage: Stage;
  readonly outcome: StageOutcome;
  readonly detail: string;
}

export interface RunSummary {
  readonly environment: 'live' | 'mock';
  /** 'recorded' in RUN_STARTED, or 'inferred' from the server's mode (runs recorded before D-053). */
  readonly environmentSource: 'recorded' | 'inferred';
  readonly origin: string | null;
  readonly policyVersion: number | null;
  readonly stages: readonly StageResult[];
  readonly verdict: Verdict;
  /** Why the verdict is not e2e-verified, in plain words (empty when it is). */
  readonly gaps: readonly string[];
  readonly failureCode: string | null;
}

type Payload = Readonly<Record<string, unknown>>;
/** The part of a run event the summary reads. */
export interface EventLike {
  readonly type: string;
  readonly payload: Payload;
}
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The stage an event belongs to (null for the run's start and end). */
export function stageOf(e: EventLike): Stage | null {
  switch (e.type) {
    case 'PROVIDERS_DISCOVERED':
      return 'discovery';
    case 'CATALOG_READ':
      return 'catalogs';
    case 'PLAN_CREATED':
      return 'plan';
    case 'INFERENCE_CALLED':
      return e.payload['purpose'] === 'PLAN' ? 'plan' : 'analysis';
    case 'PURCHASE_SKIPPED':
    case 'PAYMENT_AUTHORIZED':
    case 'PAYMENT_REFUSED':
    case 'PAYMENT_FAILED':
    case 'PAYMENT_APPROVAL_REQUESTED':
    case 'PAYMENT_APPROVAL_DECIDED':
    case 'DATA_FETCHED':
    case 'DATA_REJECTED':
      return 'payments';
    case 'PAYMENT_SETTLED':
    case 'PAYMENT_UNKNOWN':
      return 'verification';
    case 'ANALYSIS_COMPLETED':
      return 'analysis';
    case 'REPORT_WRITTEN':
      return 'report';
    default:
      return null;
  }
}

/** How a log line should look: errors, warnings (refusals, skips), successes, the rest. */
export function severityOf(e: EventLike): Severity {
  const p = e.payload;
  switch (e.type) {
    case 'RUN_FAILED':
    case 'PAYMENT_FAILED':
    case 'DATA_REJECTED':
      return 'error';
    case 'ANALYSIS_COMPLETED':
      return p['accepted'] === true ? 'success' : 'error';
    case 'INFERENCE_CALLED':
      return p['status'] === 'SUCCEEDED' ? 'info' : 'error';
    case 'CATALOG_READ':
      return p['ok'] === true ? 'info' : 'warning';
    case 'PAYMENT_REFUSED':
    case 'PURCHASE_SKIPPED':
    case 'PAYMENT_UNKNOWN':
    case 'PAYMENT_APPROVAL_REQUESTED':
      return 'warning';
    case 'PAYMENT_APPROVAL_DECIDED':
      return p['decision'] === 'APPROVED' ? 'success' : 'warning';
    case 'PAYMENT_SETTLED':
    case 'RUN_FINISHED':
    case 'REPORT_WRITTEN':
      return 'success';
    default:
      return 'info';
  }
}

const FAILURE_STAGE: Readonly<Record<string, Stage>> = {
  DISCOVERY_FAILED: 'discovery',
  NO_PROVIDERS: 'discovery',
  NO_CATALOG: 'catalogs',
  PLAN_FAILED: 'plan',
  NO_DATA: 'payments',
  ANALYSIS_FAILED: 'analysis',
  ANALYSIS_INVALID: 'analysis',
  ANALYZE_FAILED: 'analysis',
};

export function summarizeRun(
  events: readonly EventLike[],
  runStatus: string,
  serverMode: 'live' | 'mock',
): RunSummary {
  const of = (type: string) => events.filter((e) => e.type === type);
  const started: Payload = of('RUN_STARTED')[0]?.payload ?? {};
  const recordedEnv = started['environment'];
  const environment = recordedEnv === 'live' || recordedEnv === 'mock' ? recordedEnv : serverMode;
  const startedPolicy = started['policy'];
  const policyVersion =
    typeof startedPolicy === 'object' && startedPolicy !== null
      ? (startedPolicy as Payload)['version']
      : null;
  const failed: Payload | undefined = of('RUN_FAILED')[0]?.payload;
  const failureCode = failed === undefined ? null : str(failed['code']);
  const failedStage = failureCode === null ? undefined : FAILURE_STAGE[failureCode];
  const running = runStatus === 'RUNNING' || runStatus === 'QUEUED';

  const outcome = new Map<Stage, { outcome: StageOutcome; detail: string }>();
  const set = (stage: Stage, o: StageOutcome, detail: string) =>
    outcome.set(stage, { outcome: o, detail });

  // discovery
  const disc = of('PROVIDERS_DISCOVERED')[0]?.payload;
  if (disc !== undefined) {
    const n = Array.isArray(disc['providers']) ? disc['providers'].length : 0;
    set(
      'discovery',
      n > 0 ? 'done' : 'failed',
      `${n} provider${n === 1 ? '' : 's'} at Sepolia block ${str(disc['blockNumber']) ?? '?'}`,
    );
  }

  // catalogs
  const cats = of('CATALOG_READ');
  if (cats.length > 0) {
    const ok = cats.filter((c) => c.payload['ok'] === true).length;
    const expected =
      disc !== undefined && Array.isArray(disc['providers']) ? disc['providers'].length : 0;
    // catalogs are read one provider at a time: while the run is still reading them, a
    // failed first one (a waking host) is not yet the stage's outcome (D-083)
    if (running && cats.length < expected)
      set('catalogs', 'running', `${ok} of ${cats.length} read so far agree with ENS`);
    else
      set(
        'catalogs',
        ok === cats.length ? 'done' : ok > 0 ? 'partial' : 'failed',
        `${ok} of ${cats.length} catalogs agree with ENS`,
      );
  }

  // plan
  const plan = of('PLAN_CREATED')[0]?.payload;
  const planCall = of('INFERENCE_CALLED').find((e) => e.payload['purpose'] === 'PLAN')?.payload;
  const planned =
    plan !== undefined && Array.isArray(plan['purchases']) ? plan['purchases'].length : 0;
  if (plan !== undefined)
    set('plan', 'done', `${planned} purchase${planned === 1 ? '' : 's'} planned by 0G`);
  else if (planCall !== undefined)
    set('plan', 'failed', `0G plan ${str(planCall['status']) ?? ''}`.trim());

  // payments
  const authorized = of('PAYMENT_AUTHORIZED').length;
  const refused = of('PAYMENT_REFUSED').length;
  const skipped = of('PURCHASE_SKIPPED').length;
  const payFailed = of('PAYMENT_FAILED').length;
  const settled = of('PAYMENT_SETTLED').length;
  const unknown = of('PAYMENT_UNKNOWN').length;
  const fetched = of('DATA_FETCHED').length;
  const asked = of('PAYMENT_APPROVAL_REQUESTED').length;
  // asked and not yet answered: the run is waiting for the owner, not failing (D-066)
  const awaiting = running ? asked - of('PAYMENT_APPROVAL_DECIDED').length : 0;
  if (plan !== undefined) {
    if (planned === 0) set('payments', 'skipped', 'the plan needed no purchases');
    else if (authorized + refused + skipped + payFailed + fetched + asked > 0) {
      const parts = [
        `${authorized} approved by the firewall`,
        ...(asked > 0 ? [`${asked} sent to the owner for approval`] : []),
        ...(refused > 0 ? [`${refused} refused`] : []),
        ...(skipped > 0 ? [`${skipped} skipped`] : []),
        ...(payFailed > 0 ? [`${payFailed} failed`] : []),
      ];
      const anyGood = authorized > 0 || fetched > 0;
      const anyBad = refused + skipped + payFailed > 0;
      if (awaiting > 0)
        set(
          'payments',
          'running',
          [...parts, `${awaiting} waiting for the owner's approval`].join(', '),
        );
      else set('payments', anyGood ? (anyBad ? 'partial' : 'done') : 'failed', parts.join(', '));
    }
  }

  // verification (Mirror Node)
  if (authorized > 0) {
    const resolved = settled + unknown + payFailed;
    if (resolved > 0 || !running)
      set(
        'verification',
        settled === authorized ? 'done' : settled > 0 ? 'partial' : 'failed',
        `${settled} of ${authorized} settled and verified on the Mirror Node${unknown > 0 ? `, ${unknown} outcome unknown` : ''}`,
      );
  } else if (outcome.has('payments') && awaiting <= 0) {
    set('verification', 'skipped', 'no payment was sent');
  }

  // analysis
  const analysis = of('ANALYSIS_COMPLETED')[0]?.payload;
  // accepted without an ANALYZE call: the paid data held no advisories, so 0G was never
  // asked (D-083); the stage says so instead of claiming an analysis
  const analyzeCalled = of('INFERENCE_CALLED').some((e) => e.payload['purpose'] === 'ANALYZE');
  const analysisSkipped = analysis?.['accepted'] === true && !analyzeCalled;
  if (analysisSkipped)
    set('analysis', 'skipped', 'the paid data had no advisories, so 0G was not called');
  else if (analysis !== undefined)
    set(
      'analysis',
      analysis['accepted'] === true ? 'done' : 'failed',
      analysis['accepted'] === true
        ? `0G analysis accepted (${String(analysis['items'] ?? 0)} advisories)`
        : `0G analysis rejected (${str(analysis['code']) ?? 'no code'})`,
    );
  else if (planned === 0 && plan !== undefined) set('analysis', 'skipped', 'nothing was bought');

  // report
  if (of('REPORT_WRITTEN').length > 0) set('report', 'done', 'brief written');

  // a failure code names the stage that stopped the run
  if (failedStage !== undefined && outcome.get(failedStage)?.outcome !== 'failed')
    set(failedStage, 'failed', `stopped: ${failureCode ?? ''}`);

  // one stage in progress at a time (a payment waiting for approval is that stage)
  let reachedRunning = [...outcome.values()].some((o) => o.outcome === 'running');
  const stages: StageResult[] = STAGES.map((stage) => {
    const o = outcome.get(stage);
    if (o !== undefined) return { stage, ...o };
    if (running && !reachedRunning) {
      reachedRunning = true;
      return { stage, outcome: 'running', detail: 'in progress' };
    }
    return { stage, outcome: 'not-reached', detail: running ? 'waiting' : 'not reached' };
  });

  const gaps: string[] = [];
  if (environment === 'mock') gaps.push('mock run: fake ENS, providers, Hedera and 0G');
  if (running) gaps.push('the run has not finished');
  else if (runStatus !== 'SUCCEEDED')
    gaps.push(
      `the run ${runStatus.toLowerCase()}${failureCode === null ? '' : ` (${failureCode})`}`,
    );
  if (settled === 0 && !running) gaps.push('no payment was settled and verified');
  if (unknown > 0)
    gaps.push(`${unknown} payment outcome${unknown === 1 ? ' is' : 's are'} unknown`);
  if (analysisSkipped)
    gaps.push('no 0G analysis: the paid data had no advisories, so 0G was not called');
  else if (analysis?.['accepted'] !== true && !running) gaps.push('no accepted 0G analysis');
  if (of('REPORT_WRITTEN').length === 0 && !running) gaps.push('no brief was written');

  const verdict: Verdict =
    environment === 'mock'
      ? 'mock'
      : running
        ? 'in-progress'
        : runStatus !== 'SUCCEEDED'
          ? 'failed'
          : gaps.length > 0
            ? 'completed-with-gaps'
            : 'e2e-verified';
  return {
    environment,
    environmentSource: recordedEnv === 'live' || recordedEnv === 'mock' ? 'recorded' : 'inferred',
    origin: str(started['origin']),
    policyVersion: typeof policyVersion === 'number' ? policyVersion : null,
    stages,
    verdict,
    gaps,
    failureCode,
  };
}
