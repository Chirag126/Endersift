/**
 * The orchestrator (plan row 24, D-046): one run, from a watchlist to a brief,
 * every step recorded as an append-only run event.
 *
 *   RUN_STARTED
 *   discover     ENS (one pinned block)                 → PROVIDERS_DISCOVERED
 *   catalogs     free description per provider, checked
 *                against ENS, through the net-guard      → CATALOG_READ (one per provider)
 *   plan         0G (PLAN), through the inference ledger → INFERENCE_CALLED, PLAN_CREATED
 *   purchases    per planned purchase, in order:
 *                URL built from the catalog (never by the model) → PURCHASE_SKIPPED if impossible
 *                buyer: 402 → firewall → sign → tx ID persisted → send → Mirror Node
 *                                                       → PAYMENT_REFUSED | PAYMENT_AUTHORIZED +
 *                                                         PAYMENT_SETTLED | PAYMENT_UNKNOWN | PAYMENT_FAILED
 *                data used only from SETTLED purchases, schema-checked
 *                                                       → DATA_FETCHED | DATA_REJECTED
 *   analyse      0G (ANALYZE) on the purchased items     → INFERENCE_CALLED, ANALYSIS_COMPLETED
 *   report       rendered from recorded data             → REPORT_WRITTEN
 *   RUN_FINISHED (SUCCEEDED) or RUN_FAILED (FAILED, with a code)
 *
 * Rules:
 *   - The model proposes; it never builds a URL, names a payee or sets a budget.
 *     The firewall (D-041) decides every payment on the live quote.
 *   - Nothing is retried. A payment whose outcome is unknown stays UNKNOWN
 *     (counted against the budgets) for the reconciler; an inference call
 *     whose outcome is unknown stays counted at its worst case (D-040).
 *   - Every event is written before the run's status changes, and the database
 *     refuses events on a finished run, gaps in the sequence, edits and deletes
 *     (migration 5).
 *   - A crash leaves the run RUNNING; `recoverInterrupted` closes such runs as
 *     FAILED (INTERRUPTED) without touching their payments: those are resolved
 *     from the Mirror Node only (D-042, D-044).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  IntelResponse,
  type InferenceCall,
  type PaymentIntent,
  type ProviderAgent,
  type PurchasePlan,
  type Run,
  type RunEventType,
  type StackAnalysis,
} from '@agent-economy/core/domain';
import type { SpendingPolicy } from '@agent-economy/policy';
import { promptTokenUpperBound, structuredMessages, type StructuredTask } from '@agent-economy/zg';
import {
  appendRunEvent,
  createRun,
  getRun,
  saveReport,
  startRun,
  updateRun,
  upsertProvider,
} from '../db/repositories.ts';
import { redactText } from '../api/redact.ts';
import type { ApprovalAnswer, BuyInput, BuyOutcome } from '../payments/x402-buyer.ts';
import type { ApprovalStore } from '../payments/approvals.ts';
import { AUTONOMOUS, needsApproval, type ApprovalRule } from '../policy/policy-store.ts';
import { buildPurchaseUrl, readCatalog, type CatalogResult } from './catalog.ts';
import {
  advisoryIdsIn,
  analysisTask,
  inventedIds,
  planTask,
  relevance,
  selectItems,
  ungroundedIds,
  watchlistTerms,
  type SourcedItem,
} from './prompts.ts';
import { computeDelta, digestOf, previousDigest, type Delta, type Digest } from './delta.ts';
import { renderReport } from './report.ts';

export interface SkippedProvider {
  readonly label: string;
  readonly code: string;
  readonly reason: string;
}

export interface DiscoveryResult {
  readonly parent: string;
  readonly blockNumber: bigint;
  readonly observedAt: string;
  readonly providers: readonly ProviderAgent[];
  /** Names under the parent that were found but are not usable, with why (ENS discovery). */
  readonly skipped?: readonly SkippedProvider[];
  /** Whether loopback http endpoints were accepted (the local provider service). */
  readonly allowLocalHttp?: boolean;
}

/** Why no provider is usable, in one sentence a person can act on. Pure. */
export function noProvidersMessage(d: DiscoveryResult): string {
  const skipped = d.skipped ?? [];
  if (skipped.length === 0)
    return `no agent is registered under ${d.parent} (scanned to block ${d.blockNumber}; check the scan start block)`;
  const list = skipped
    .slice(0, 6)
    .map((s) => `${s.label}: ${s.code} (${s.reason})`)
    .join('; ');
  const loopback = skipped.some((s) =>
    /loopback|http only for localhost|must use https/.test(s.reason),
  );
  const hint =
    loopback && d.allowLocalHttp !== true
      ? ' The records point to the local provider service: start the API with --allow-local-http and run pnpm providers:start.'
      : '';
  return `no usable provider under ${d.parent}: ${list}.${hint}`;
}

export type InferOutcome<T> =
  | { readonly ok: true; readonly call: InferenceCall; readonly value: T }
  | {
      readonly ok: false;
      readonly call: InferenceCall;
      readonly code: string;
      readonly reason: string;
      /** Schema issues as "path: message" (never the offending values), when the output was rejected. */
      readonly issues?: readonly string[];
    };

export interface InferRequest<T> {
  readonly runId: string;
  readonly purpose: 'PLAN' | 'ANALYZE';
  readonly task: StructuredTask<T>;
  readonly maxTokens: number;
}

/** One ledgered 0G call (`ledgeredInference` in production). */
export type Infer = <T>(request: InferRequest<T>) => Promise<InferOutcome<T>>;

export interface OrchestratorLimits {
  /** Purchases attempted per run (also bounded by policy.maxPaymentsPerRun). */
  readonly maxPurchases: number;
  /** Advisories given to the analyst. */
  readonly maxItems: number;
  readonly planMaxTokens: number;
  readonly analyzeMaxTokens: number;
  /**
   * Upper bound on the analysis prompt's tokens (byte bound, as the ledger
   * computes it). Advisories are dropped from the end of the ranked list until
   * the prompt fits, so the call fits the per-call cap. null = no bound.
   */
  readonly analyzePromptTokens: number | null;
  /**
   * How long a run keeps retrying a provider catalog that cannot be read yet
   * (unreachable, timed out, 5xx, not JSON), every few seconds, while a
   * sleeping provider host wakes (Render free plan, D-062). 0 = one attempt.
   * Catalog reads are free: no payment is involved.
   */
  readonly catalogWakeMs: number;
}

/** Catalog failures worth retrying while a provider host wakes up (D-062). */
const WAKE_RETRYABLE = new Set([
  'CATALOG_UNREACHABLE',
  'CATALOG_HTTP_ERROR',
  'CATALOG_INVALID',
  'NET_TIMEOUT',
]);
/** Pause between catalog attempts while a provider host wakes. */
export const WAKE_RETRY_MS = 5_000;

/** The host a provider endpoint is on (its origin), or the endpoint itself if it is not a URL. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

export const DEFAULT_LIMITS: OrchestratorLimits = {
  maxPurchases: 3,
  maxItems: 30,
  planMaxTokens: 1024,
  analyzeMaxTokens: 2048,
  analyzePromptTokens: null,
  catalogWakeMs: 0,
};

export interface OrchestratorDeps {
  readonly db: DatabaseSync;
  readonly discover: () => Promise<DiscoveryResult>;
  /** The net-guard fetch (`buyerFetch`) in production; used for provider catalogs. */
  readonly fetch: typeof globalThis.fetch;
  /** `buyWithFirewall` bound to its deps. */
  readonly buy: (input: BuyInput) => Promise<BuyOutcome>;
  readonly infer: Infer;
  readonly payments: { listByRun(runId: string): Promise<PaymentIntent[]> };
  readonly inference: { listCalls(filter: { runId: string }): Promise<InferenceCall[]> };
  /** The configured policy (env); used when there is no policySource. */
  readonly policy: SpendingPolicy;
  /**
   * The policy in force now (the owner's persisted policy under the env
   * ceiling, D-052). Read when a run starts and again before every purchase,
   * so a pause or a lowered limit applies to the next payment of a running task.
   */
  readonly policySource?: () => PolicySnapshot;
  /** Recorded in RUN_STARTED: real networks ('live') or the test harness ('mock'). */
  readonly environment: 'live' | 'mock';
  readonly hashscan: (transactionId: string) => string;
  /**
   * Called once the run is closed (SUCCEEDED or FAILED), e.g. the HCS auditor
   * (D-057). Its errors are reported, never raised: they cannot change the run.
   */
  readonly afterRun?: (runId: string) => Promise<void>;
  readonly onAfterRunError?: (runId: string, error: unknown) => void;
  /**
   * Before any 0G call or payment: read today's spend from outside this
   * database (the Mirror Node, D-062), so the daily budget survives a wiped
   * database. A throw fails the run with SPEND_UNVERIFIED, nothing spent.
   */
  readonly spendCheck?: () => Promise<unknown>;
  readonly limits?: Partial<OrchestratorLimits>;
  readonly now?: () => Date;
  readonly newId?: () => string;
  /**
   * Human approval mode (D-066): where approval requests are recorded and
   * answered. Without it, a payment that needs approval is never paid.
   */
  readonly approvals?: Pick<ApprovalStore, 'request' | 'wait'>;
  /**
   * The agent's own earnings account (D-066): a provider paid to it is the
   * agent itself (its brief for sale) and is never bought. null = none.
   */
  readonly earningsAccount?: string | null;
  /** Waiting between catalog attempts (tests replace it). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in milliseconds, for the catalog wake deadline (tests replace it). */
  readonly monotonicMs?: () => number;
}

export interface PolicySnapshot {
  readonly policy: SpendingPolicy;
  /** The owner's policy version; null = the env configuration. */
  readonly version: number | null;
  /** Who approves payments (D-066); absent = autonomous. */
  readonly approval?: ApprovalRule;
}

/** Who started a run (recorded in RUN_STARTED; the runs table predates it). */
export const RUN_ORIGINS = ['api', 'cli', 'scheduler'] as const;
export type RunOrigin = (typeof RUN_ORIGINS)[number];

export interface RunRequest {
  readonly trigger: Run['trigger'];
  readonly watchlist: readonly string[];
}

export interface ExecuteOptions {
  /** This run's budget (atomic units); may only lower policy.maxPerRun (and caps maxPerPayment). */
  readonly budget?: bigint;
  readonly origin?: RunOrigin;
}

/** The policy for one run: the configured one, lowered by the run's budget. Throws if it would raise it. */
export function runPolicy(base: SpendingPolicy, budget: bigint | undefined): SpendingPolicy {
  if (budget === undefined) return base;
  if (budget <= 0n || budget > base.maxPerRun)
    throw new RangeError(
      `budget must be between 1 and ${base.maxPerRun} (the configured run budget)`,
    );
  return {
    ...base,
    maxPerRun: budget,
    maxPerPayment: budget < base.maxPerPayment ? budget : base.maxPerPayment,
  };
}

export interface RunResult {
  readonly run: Run;
  readonly report: string | null;
}

/** Thrown inside a run to end it as FAILED with a code (never escapes `execute`). */
class RunFailure extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** Starting a task while the owner has paused payments. */
export class PaymentsPausedError extends Error {
  constructor() {
    super('payments are paused by the owner; resume them under Spending rules first');
    this.name = 'PaymentsPausedError';
  }
}

/** The tighter of two policies, field by field; a pause in either wins. Pure. */
export function tighter(a: SpendingPolicy, b: SpendingPolicy): SpendingPolicy {
  const min = (x: bigint, y: bigint) => (x < y ? x : y);
  // per-provider caps (D-066): every cap of either, the lower where both set one
  const caps: Record<string, bigint> = { ...(a.providerDailyCaps ?? {}) };
  for (const [name, cap] of Object.entries(b.providerDailyCaps ?? {}))
    caps[name] = caps[name] === undefined ? cap : min(caps[name], cap);
  return {
    ...a,
    maxPerPayment: min(a.maxPerPayment, b.maxPerPayment),
    maxPerRun: min(a.maxPerRun, b.maxPerRun),
    maxPerDay: min(a.maxPerDay, b.maxPerDay),
    maxPaymentsPerRun: Math.min(a.maxPaymentsPerRun, b.maxPaymentsPerRun),
    paymentsPaused: a.paymentsPaused === true || b.paymentsPaused === true,
    ...(Object.keys(caps).length > 0 ? { providerDailyCaps: caps } : {}),
  };
}

type MaybeReportRow = { readonly markdown: string } | undefined;

// Redacted before it is stored: run events and run errors are append-only, so a
// secret written once could never be removed (D-054). The API redacts again on the way out.
const errorText = (e: unknown): string =>
  redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500);

/** Why an allowed purchase was not paid in Human approval mode (D-066), in plain words. */
export function notApprovedReason(code: string): string {
  switch (code) {
    case 'APPROVAL_REJECTED':
      return 'the owner rejected this payment; it was never signed';
    case 'APPROVAL_EXPIRED':
      return 'nobody approved this payment in time; it was never signed';
    case 'PAYMENTS_PAUSED':
      return 'payments were paused while this payment waited for approval; it was never signed';
    case 'APPROVAL_QUOTE_CHANGED':
      return 'the provider changed its quote after approval; nothing was signed';
    case 'REQUOTE_FAILED':
      return 'the provider could not be asked for its quote again after approval; nothing was signed';
    default:
      return 'the payment needed approval, which could not be asked; it was never signed';
  }
}

export class Orchestrator {
  readonly #d: OrchestratorDeps;
  readonly #limits: OrchestratorLimits;

  constructor(deps: OrchestratorDeps) {
    this.#d = deps;
    this.#limits = { ...DEFAULT_LIMITS, ...deps.limits };
  }

  #now(): string {
    return (this.#d.now ?? (() => new Date()))().toISOString();
  }

  #policyNow(): PolicySnapshot {
    return this.#d.policySource?.() ?? { policy: this.#d.policy, version: null };
  }

  #emit(runId: string, type: RunEventType, payload: Record<string, unknown>): void {
    appendRunEvent(this.#d.db, { runId, type, payload, at: this.#now() });
  }

  /** Create a QUEUED run. */
  queue(request: RunRequest): Run {
    return createRun(this.#d.db, {
      id: (this.#d.newId ?? randomUUID)(),
      trigger: request.trigger,
      watchlist: [...request.watchlist],
      status: 'QUEUED',
      createdAt: this.#now(),
      startedAt: null,
      finishedAt: null,
      error: null,
    });
  }

  /**
   * Throws a RangeError if `budget` would raise the run budget in force, and a
   * PaymentsPausedError while the owner has paused payments (nothing is recorded).
   */
  checkBudget(budget: bigint | undefined): void {
    const { policy } = this.#policyNow();
    if (policy.paymentsPaused === true) throw new PaymentsPausedError();
    runPolicy(policy, budget);
  }

  /** Queue and execute. */
  async run(request: RunRequest, options: ExecuteOptions = {}): Promise<RunResult> {
    this.checkBudget(options.budget); // refuse a bad budget before anything is recorded
    return this.execute(this.queue(request).id, options);
  }

  /** Execute a QUEUED run to the end. Throws only if the run cannot be started or recorded. */
  async execute(runId: string, options: ExecuteOptions = {}): Promise<RunResult> {
    const snapshot = this.#policyNow();
    // a budget the owner's (lowered) policy no longer allows is lowered to it, never raised
    const base = snapshot.policy;
    const budget =
      options.budget !== undefined && options.budget > base.maxPerRun
        ? base.maxPerRun
        : options.budget;
    const policy = runPolicy(base, budget);
    const started = startRun(this.#d.db, runId, this.#now());
    if (started === null) {
      const r = getRun(this.#d.db, runId);
      throw new Error(
        r === null
          ? `run ${runId} does not exist`
          : `run ${runId} is ${r.status}; only a QUEUED run is executed (once)`,
      );
    }
    this.#emit(runId, 'RUN_STARTED', {
      trigger: started.trigger,
      watchlist: started.watchlist,
      environment: this.#d.environment,
      origin: options.origin ?? null,
      policy: {
        network: policy.network,
        asset: policy.asset,
        maxPerPayment: policy.maxPerPayment.toString(),
        maxPerRun: policy.maxPerRun.toString(),
        maxPerDay: policy.maxPerDay.toString(),
        maxPaymentsPerRun: policy.maxPaymentsPerRun,
        paymentsPaused: policy.paymentsPaused === true,
        version: snapshot.version,
        // who approves payments and the per-provider caps at the start (D-066)
        approvalMode: (snapshot.approval ?? AUTONOMOUS).mode,
        approvalAboveTinybars: (snapshot.approval ?? AUTONOMOUS).aboveTinybars.toString(),
        providerDailyCaps: Object.fromEntries(
          Object.entries(policy.providerDailyCaps ?? {}).map(([k, v]) => [k, v.toString()]),
        ),
      },
      limits: this.#limits,
    });

    let report: string | null = null;
    try {
      // queued before a pause: stop before any 0G or HBAR is spent
      if (policy.paymentsPaused === true)
        throw new RunFailure('PAYMENTS_PAUSED', 'payments are paused by the owner');
      if (this.#d.spendCheck !== undefined) {
        try {
          await this.#d.spendCheck();
        } catch (error) {
          throw new RunFailure(
            'SPEND_UNVERIFIED',
            `today's spend could not be read from the Mirror Node, so nothing is spent: ${errorText(error)}`,
          );
        }
      }
      report = await this.#pipeline(started, policy);
      this.#emit(runId, 'RUN_FINISHED', await this.#totals(runId));
      const finished = updateRun(this.#d.db, {
        ...started,
        status: 'SUCCEEDED',
        finishedAt: this.#now(),
      });
      await this.#afterRun(runId);
      return { run: finished, report };
    } catch (error) {
      const failure =
        error instanceof RunFailure ? error : new RunFailure('INTERNAL', errorText(error));
      // A failure after the purchase stage still has its report (it records the payments).
      report = failure.detail['report'] === true ? this.#reportOf(runId) : null;
      this.#emit(runId, 'RUN_FAILED', {
        code: failure.code,
        message: failure.message,
        ...(await this.#totals(runId)),
      });
      const finished = updateRun(this.#d.db, {
        ...started,
        status: 'FAILED',
        finishedAt: this.#now(),
        error: `${failure.code}: ${failure.message}`.slice(0, 2000),
      });
      await this.#afterRun(runId);
      return { run: finished, report };
    }
  }

  async #afterRun(runId: string): Promise<void> {
    if (this.#d.afterRun === undefined) return;
    try {
      await this.#d.afterRun(runId);
    } catch (error) {
      this.#d.onAfterRunError?.(runId, error);
    }
  }

  #reportOf(runId: string): string | null {
    const row = this.#d.db
      .prepare('SELECT markdown FROM reports WHERE run_id = ?')
      .get(runId) as MaybeReportRow;
    return row?.markdown ?? null;
  }

  async #totals(runId: string): Promise<Record<string, unknown>> {
    const payments = await this.#d.payments.listByRun(runId);
    const calls = await this.#d.inference.listCalls({ runId });
    const sum = (ps: readonly PaymentIntent[]) =>
      ps.reduce((s, p) => s + BigInt(p.amountAtomic), 0n).toString();
    return {
      payments: {
        settled: payments.filter((p) => p.status === 'SETTLED').length,
        refused: payments.filter((p) => p.status === 'REFUSED').length,
        unknown: payments.filter((p) => p.status === 'UNKNOWN').length,
        failed: payments.filter((p) => p.status === 'FAILED').length,
        settledAtomic: sum(payments.filter((p) => p.status === 'SETTLED')),
      },
      inference: {
        calls: calls.length,
        succeeded: calls.filter((c) => c.status === 'SUCCEEDED').length,
        costNeuron: calls.reduce((s, c) => s + BigInt(c.costNeuron ?? '0'), 0n).toString(),
      },
    };
  }

  /** One 0G call; a throw before any ledger row (e.g. the model catalog is unreachable) fails the step. */
  async #infer<T>(request: InferRequest<T>): Promise<InferOutcome<T>> {
    try {
      return await this.#d.infer(request);
    } catch (error) {
      throw new RunFailure(`${request.purpose}_FAILED`, errorText(error));
    }
  }

  #inferenceEvent(runId: string, call: InferenceCall): void {
    this.#emit(runId, 'INFERENCE_CALLED', {
      callId: call.id,
      purpose: call.purpose,
      status: call.status,
      model: call.model,
      requestId: call.requestId,
      costNeuron: call.costNeuron,
      worstCaseNeuron: call.worstCaseNeuron,
      funding: call.funding,
      teeVerified: call.teeVerified,
      errorCode: call.errorCode,
    });
  }

  /**
   * One provider's catalog, retried every WAKE_RETRY_MS until `catalogWakeMs`
   * has passed while the failure is one a waking host gives (D-062). Providers
   * on the same host share one wait per run (D-085): a host that did not wake
   * for the first is not waited for again for the next.
   */
  async #readCatalogWaking(
    p: ProviderAgent,
    deadlines: Map<string, number>,
  ): Promise<{ result: CatalogResult; attempts: number }> {
    const d = this.#d;
    let result = await readCatalog(d.fetch, p);
    let attempts = 1;
    const wakeMs = this.#limits.catalogWakeMs;
    if (wakeMs <= 0) return { result, attempts };
    const clock = d.monotonicMs ?? (() => performance.now());
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const host = hostOf(p.endpoint);
    const deadline = deadlines.get(host) ?? clock() + wakeMs;
    deadlines.set(host, deadline);
    while (!result.ok && WAKE_RETRYABLE.has(result.code) && clock() + WAKE_RETRY_MS <= deadline) {
      await sleep(WAKE_RETRY_MS);
      result = await readCatalog(d.fetch, p);
      attempts += 1;
    }
    return { result, attempts };
  }

  /**
   * The approval step for one purchase (D-066): records the request and the
   * owner's answer as run events around the wait. Without an approval store
   * the request cannot be asked, and the payment is not made.
   */
  #approvalGate(
    runId: string,
    index: number,
    operation: string,
    rule: ApprovalRule,
  ): NonNullable<BuyInput['approval']> {
    const store = this.#d.approvals;
    return {
      needed: (amount) => needsApproval(rule, amount),
      policyNow: () => this.#policyNow().policy,
      ask: async ({ intent, amount }): Promise<ApprovalAnswer> => {
        if (store === undefined) throw new Error('approvals are not available in this process');
        const asked = store.request({
          runId,
          paymentId: intent.id,
          provider: intent.provider,
          capability: intent.capability,
          payTo: intent.payTo,
          amountAtomic: amount.toString(),
          requestUrl: intent.requestUrl,
          threshold: rule.aboveTinybars,
        });
        this.#emit(runId, 'PAYMENT_APPROVAL_REQUESTED', {
          index,
          approvalId: asked.id,
          intentId: intent.id,
          provider: intent.provider,
          capability: intent.capability,
          operation,
          amountAtomic: asked.amountAtomic,
          payTo: asked.payTo,
          url: asked.requestUrl,
          threshold: asked.threshold,
          expiresAt: asked.expiresAt,
        });
        const done = await store.wait(asked.id);
        const decision = done.status === 'PENDING' ? 'EXPIRED' : done.status;
        this.#emit(runId, 'PAYMENT_APPROVAL_DECIDED', {
          index,
          approvalId: asked.id,
          intentId: intent.id,
          decision,
          decidedBy: done.decidedBy,
          note: done.note,
        });
        return { decision, approvalId: asked.id };
      },
    };
  }

  async #pipeline(run: Run, policy: SpendingPolicy): Promise<string> {
    const runId = run.id;
    const d = this.#d;

    // ── discover ────────────────────────────────────────────────────────
    let discovery: DiscoveryResult;
    try {
      discovery = await d.discover();
    } catch (error) {
      throw new RunFailure('DISCOVERY_FAILED', errorText(error));
    }
    for (const p of discovery.providers) upsertProvider(d.db, p);
    this.#emit(runId, 'PROVIDERS_DISCOVERED', {
      parent: discovery.parent,
      blockNumber: discovery.blockNumber.toString(),
      observedAt: discovery.observedAt,
      providers: discovery.providers.map((p) => ({
        ensName: p.ensName,
        endpoint: p.endpoint,
        capabilities: p.capabilities,
        priceAtomic: p.priceAtomic,
        payTo: p.payTo,
      })),
      skipped: (discovery.skipped ?? []).slice(0, 20),
    });
    if (discovery.providers.length === 0)
      throw new RunFailure('NO_PROVIDERS', noProvidersMessage(discovery));

    // ── catalogs ────────────────────────────────────────────────────────
    const catalogs = new Map<string, CatalogResult>();
    const wakeDeadlines = new Map<string, number>();
    for (const p of discovery.providers) {
      const { result: c, attempts } = await this.#readCatalogWaking(p, wakeDeadlines);
      catalogs.set(p.ensName, c);
      this.#emit(runId, 'CATALOG_READ', {
        ...(c.ok
          ? {
              provider: p.ensName,
              ok: true,
              operations: c.operations.map((o) => ({
                name: o.name,
                path: o.path,
                params: Object.keys(o.params),
              })),
              dropped: c.dropped,
            }
          : { provider: p.ensName, ok: false, code: c.code, reason: c.reason }),
        ...(attempts > 1 ? { attempts } : {}),
      });
    }
    if (![...catalogs.values()].some((c) => c.ok))
      throw new RunFailure('NO_CATALOG', 'no provider served a catalog that agrees with ENS');

    // ── plan ────────────────────────────────────────────────────────────
    const maxPurchases = Math.min(this.#limits.maxPurchases, policy.maxPaymentsPerRun);
    const planned = await this.#infer<PurchasePlan>({
      runId,
      purpose: 'PLAN',
      task: planTask({
        today: this.#now().slice(0, 10),
        watchlist: run.watchlist,
        catalogs: [...catalogs.values()],
        maxPurchases,
        runBudget: policy.maxPerRun,
      }),
      maxTokens: this.#limits.planMaxTokens,
    });
    this.#inferenceEvent(runId, planned.call);
    if (!planned.ok)
      throw new RunFailure(
        'PLAN_FAILED',
        `${planned.code}: ${planned.reason}${planned.issues === undefined || planned.issues.length === 0 ? '' : ` (${planned.issues.slice(0, 3).join('; ')})`}`,
      );
    const plan = planned.value;
    this.#emit(runId, 'PLAN_CREATED', {
      callId: planned.call.id,
      focus: plan.focus,
      purchases: plan.purchases,
      maxPurchases,
    });

    // ── purchases ───────────────────────────────────────────────────────
    const responses: { provider: string; response: IntelResponse }[] = [];
    const skipped: { what: string; code: string }[] = [];
    const tried = new Set<string>();
    // IDs a purchase may name: those in the watchlist, plus those in data bought so far
    const grounded = advisoryIdsIn(run.watchlist);
    let attempted = 0;
    for (const [index, purchase] of plan.purchases.entries()) {
      const what = `${purchase.provider} ${purchase.capability} (${purchase.operation})`;
      const skip = (code: string, reason: string, extra: Record<string, unknown> = {}) => {
        skipped.push({ what, code });
        this.#emit(runId, 'PURCHASE_SKIPPED', {
          index,
          provider: purchase.provider,
          capability: purchase.capability,
          operation: purchase.operation,
          code,
          reason,
          ...extra,
        });
      };
      if (attempted >= maxPurchases) {
        skip('PLAN_LIMIT', `only ${maxPurchases} purchases per run`);
        continue;
      }
      const built = buildPurchaseUrl(catalogs, purchase);
      if (!built.ok) {
        skip(built.code, built.reason);
        continue;
      }
      const ungrounded = ungroundedIds(purchase.params, grounded);
      if (ungrounded.length > 0) {
        skip(
          'UNGROUNDED_IDS',
          `advisory IDs neither in the watchlist nor in data bought this run: ${ungrounded.slice(0, 5).join(', ')}`,
          { ids: ungrounded.slice(0, 20) },
        );
        continue;
      }
      if (tried.has(built.url)) {
        skip('DUPLICATE_PURCHASE', 'the plan repeats a purchase', { url: built.url });
        continue;
      }
      tried.add(built.url);
      const target = discovery.providers.find((p) => p.ensName === purchase.provider);
      if (
        target !== undefined &&
        d.earningsAccount !== undefined &&
        d.earningsAccount !== null &&
        target.payTo === d.earningsAccount
      ) {
        skip('SELF_PROVIDER', 'this provider is the agent itself (its own brief for sale)', {
          url: built.url,
        });
        continue;
      }
      attempted += 1;

      // Human approval mode (D-066): read per purchase, so a switch applies to the next payment
      const inForce = this.#policyNow();
      const rule = inForce.approval ?? AUTONOMOUS;
      const outcome = await d.buy({
        runId,
        intent: {
          provider: purchase.provider,
          capability: purchase.capability,
          rationale: purchase.rationale,
        },
        url: built.url,
        providers: discovery.providers,
        snapshot: { blockNumber: discovery.blockNumber, observedAt: discovery.observedAt },
        // the run's limits, tightened by any change since it started (a pause applies at once)
        policy: tighter(policy, inForce.policy),
        ...(rule.mode === 'human'
          ? { approval: this.#approvalGate(runId, index, purchase.operation, rule) }
          : {}),
      });
      const provider = discovery.providers.find((p) => p.ensName === purchase.provider);
      const label = provider?.label ?? '';
      switch (outcome.kind) {
        case 'rejected':
          skip(outcome.code, outcome.reason, { url: built.url });
          break;
        case 'existing':
          skip('DUPLICATE_PURCHASE', `intent ${outcome.intent.id} is ${outcome.intent.status}`, {
            url: built.url,
            intentId: outcome.intent.id,
          });
          break;
        case 'free': {
          const intel = IntelResponse.safeParse(outcome.body);
          if (outcome.status === 200 && intel.success && intel.data.provider === label) {
            responses.push({ provider: purchase.provider, response: intel.data });
            for (const it of intel.data.items)
              for (const id of [it.id, ...it.aliases]) grounded.add(id.toUpperCase());
            this.#emit(runId, 'DATA_FETCHED', {
              index,
              provider: purchase.provider,
              paid: false,
              url: built.url,
              ...this.#dataSummary(intel.data),
            });
          } else {
            skip(`PROVIDER_HTTP_${outcome.status}`, 'the provider answered without a 402', {
              url: built.url,
            });
          }
          break;
        }
        case 'not-approved':
          skip(outcome.code, notApprovedReason(outcome.code), {
            url: built.url,
            intentId: outcome.intent.id,
            approvalId: outcome.approval?.approvalId ?? null,
          });
          break;
        case 'refused':
          skipped.push({ what, code: outcome.intent.refusalCode ?? 'REFUSED' });
          this.#emit(runId, 'PAYMENT_REFUSED', {
            index,
            intentId: outcome.intent.id,
            provider: purchase.provider,
            capability: purchase.capability,
            code: outcome.decision.allow ? null : outcome.decision.code,
            reason: outcome.decision.allow ? null : outcome.decision.reason,
          });
          break;
        case 'paid': {
          const i = outcome.intent;
          if (outcome.decision.allow)
            this.#emit(runId, 'PAYMENT_AUTHORIZED', {
              index,
              intentId: i.id,
              provider: i.provider,
              capability: i.capability,
              amountAtomic: i.amountAtomic,
              payTo: i.payTo,
              url: i.requestUrl,
            });
          const tx = i.transactionId;
          if (i.status === 'SETTLED') {
            const v = outcome.verifications.findLast((x) => x.outcome === 'SETTLED');
            this.#emit(runId, 'PAYMENT_SETTLED', {
              index,
              intentId: i.id,
              transactionId: tx,
              consensusTimestamp: v?.consensusTimestamp ?? null,
              verificationId: v?.id ?? null,
              hashscan: tx === null ? null : d.hashscan(tx),
            });
          } else if (i.status === 'UNKNOWN') {
            this.#emit(runId, 'PAYMENT_UNKNOWN', {
              index,
              intentId: i.id,
              transactionId: tx,
              errorCode: i.errorCode,
            });
          } else {
            this.#emit(runId, 'PAYMENT_FAILED', {
              index,
              intentId: i.id,
              status: i.status,
              transactionId: tx,
              errorCode: i.errorCode,
            });
          }
          const reject = (code: string, reason: string) => {
            skipped.push({ what, code });
            this.#emit(runId, 'DATA_REJECTED', { index, intentId: i.id, code, reason });
          };
          if (i.status !== 'SETTLED') {
            reject('NOT_SETTLED', `payment is ${i.status}; its data is not used`);
            break;
          }
          if (outcome.status !== 200) {
            reject(`HTTP_${outcome.status ?? 'NONE'}`, 'the paid request did not return data');
            break;
          }
          const intel = IntelResponse.safeParse(outcome.body);
          if (!intel.success) {
            reject(
              'SCHEMA_INVALID',
              intel.error.issues
                .slice(0, 3)
                .map((x) => `${x.path.join('.')}: ${x.message}`)
                .join('; '),
            );
            break;
          }
          if (intel.data.provider !== label) {
            reject('PROVIDER_MISMATCH', `response names "${intel.data.provider}"`);
            break;
          }
          responses.push({ provider: purchase.provider, response: intel.data });
          for (const it of intel.data.items)
            for (const id of [it.id, ...it.aliases]) grounded.add(id.toUpperCase());
          this.#emit(runId, 'DATA_FETCHED', {
            index,
            intentId: i.id,
            provider: purchase.provider,
            paid: true,
            url: i.requestUrl,
            ...this.#dataSummary(intel.data),
          });
          break;
        }
      }
    }

    // ── analyse ─────────────────────────────────────────────────────────
    let triage: StackAnalysis | null = null;
    let digest: Digest | null = null;
    let analysisNote: string | null = null;
    let items: SourcedItem[] = [];
    let failure: RunFailure | null = null;
    if (plan.purchases.length === 0) {
      // nothing to buy is a valid plan: the brief says so
    } else if (responses.length === 0) {
      failure = new RunFailure('NO_DATA', 'no planned purchase delivered usable data');
    } else {
      items = selectItems(responses, this.#limits.maxItems, run.watchlist);
      const ranked = items.length;
      let task = analysisTask({ watchlist: run.watchlist, items });
      const bound = this.#limits.analyzePromptTokens;
      while (
        bound !== null &&
        items.length > 1 &&
        promptTokenUpperBound(structuredMessages(task)) > bound
      ) {
        items = items.slice(0, -1);
        task = analysisTask({ watchlist: run.watchlist, items });
      }
      const relevantTerms = watchlistTerms(run.watchlist);
      const fit = {
        ranked,
        offered: items.length,
        relevant: items.filter((x) => relevance(x.item, relevantTerms) > 0).length,
      };
      if (items.length === 0) {
        digest = { items: [] };
        this.#emit(runId, 'ANALYSIS_COMPLETED', {
          accepted: true,
          items: 0,
          note: 'the purchased responses contain no advisories',
          digest,
        });
      } else {
        let analysed: InferOutcome<StackAnalysis> | RunFailure;
        try {
          analysed = await this.#infer<StackAnalysis>({
            runId,
            purpose: 'ANALYZE',
            task,
            maxTokens: this.#limits.analyzeMaxTokens,
          });
        } catch (error) {
          analysed =
            error instanceof RunFailure ? error : new RunFailure('INTERNAL', errorText(error));
        }
        if (analysed instanceof RunFailure) {
          this.#emit(runId, 'ANALYSIS_COMPLETED', {
            accepted: false,
            code: analysed.code,
            reason: analysed.message,
            ...fit,
          });
          analysisNote = `the 0G analysis could not be completed (${analysed.code})`;
          failure = analysed;
        } else if (!analysed.ok) {
          this.#inferenceEvent(runId, analysed.call);
          this.#emit(runId, 'ANALYSIS_COMPLETED', {
            accepted: false,
            callId: analysed.call.id,
            code: analysed.code,
            reason: analysed.reason,
            issues: analysed.issues ?? [],
            ...fit,
          });
          analysisNote = `the 0G analysis was rejected (${analysed.code})`;
          failure = new RunFailure('ANALYSIS_FAILED', `${analysed.code}: ${analysed.reason}`);
        } else {
          this.#inferenceEvent(runId, analysed.call);
          const invented = inventedIds(analysed.value, items);
          if (invented.length > 0) {
            this.#emit(runId, 'ANALYSIS_COMPLETED', {
              accepted: false,
              callId: analysed.call.id,
              code: 'INVENTED_IDS',
              invented: invented.slice(0, 20),
              ...fit,
            });
            analysisNote = 'the 0G analysis was rejected (it named advisories it was not given)';
            failure = new RunFailure(
              'ANALYSIS_INVALID',
              `the analysis names IDs it was not given: ${invented.slice(0, 5).join(', ')}`,
            );
          } else {
            triage = analysed.value;
            digest = digestOf(items, triage);
            this.#emit(runId, 'ANALYSIS_COMPLETED', {
              accepted: true,
              callId: analysed.call.id,
              items: items.length,
              ...fit,
              assessments: triage.assessments.length,
              p1: triage.assessments.filter((a) => a.priority === 'p1').map((a) => a.id),
              // what the next brief for this watchlist compares against (D-056)
              digest,
            });
          }
        }
      }
    }

    // ── delta against the previous brief for the same watchlist (D-056) ──
    let delta: Delta | null = null;
    let deltaNote: string;
    if (digest === null) {
      deltaNote = 'this run has no accepted analysis';
    } else {
      const previous = previousDigest(d.db, run);
      if (previous === null) {
        deltaNote =
          'first brief for this watchlist with a recorded digest: nothing to compare with yet';
      } else {
        delta = computeDelta(previous, digest);
        deltaNote = '';
      }
    }

    // ── report (always, once purchases were attempted: it records the payments) ──
    const markdown = renderReport({
      runId,
      generatedAt: this.#now(),
      watchlist: run.watchlist,
      ens: {
        parent: discovery.parent,
        blockNumber: discovery.blockNumber,
        providers: discovery.providers.length,
      },
      focus: plan.focus,
      payments: await d.payments.listByRun(runId),
      inference: await d.inference.listCalls({ runId }),
      items,
      triage,
      analysisNote,
      skipped,
      hashscan: d.hashscan,
      delta,
      deltaNote,
    });
    saveReport(d.db, { runId, markdown, createdAt: this.#now() });
    this.#emit(runId, 'REPORT_WRITTEN', {
      chars: markdown.length,
      advisories: items.length,
      analysed: triage !== null,
      delta:
        delta === null
          ? null
          : {
              previousRunId: delta.previousRunId,
              previousAt: delta.previousAt,
              added: delta.added.map((i) => i.id).slice(0, 30),
              gone: delta.gone.map((i) => i.id).slice(0, 30),
              changed: delta.changed.slice(0, 30),
              unchanged: delta.unchanged,
            },
    });
    if (failure !== null) throw new RunFailure(failure.code, failure.message, { report: true });
    return markdown;
  }

  #dataSummary(r: IntelResponse): Record<string, unknown> {
    return {
      operation: r.operation,
      source: r.source.name,
      count: r.count,
      truncated: r.truncated,
      notFound: r.notFound.slice(0, 20),
      ids: r.items.slice(0, 20).map((i) => i.id),
    };
  }

  /**
   * Close runs a crash left RUNNING (or QUEUED longer than `olderThanMs`) as
   * FAILED with INTERRUPTED. Payments are not touched: an UNKNOWN or SUBMITTED
   * payment is resolved by the settlement verifier from the Mirror Node only.
   */
  recoverInterrupted(olderThanMs = 0): Run[] {
    const cutoff = new Date(
      (this.#d.now ?? (() => new Date()))().getTime() - olderThanMs,
    ).toISOString();
    const rows = this.#d.db
      .prepare(
        `SELECT id FROM runs WHERE status IN ('RUNNING','QUEUED') AND COALESCE(started_at, created_at) <= ? ORDER BY created_at`,
      )
      .all(cutoff) as { id: string }[];
    const out: Run[] = [];
    for (const { id } of rows) {
      const run = getRun(this.#d.db, id);
      if (run === null) continue;
      if (run.status === 'QUEUED') {
        out.push(
          updateRun(this.#d.db, {
            ...run,
            status: 'CANCELLED',
            finishedAt: this.#now(),
            error: 'INTERRUPTED: never started',
          }),
        );
        continue;
      }
      this.#emit(id, 'RUN_FAILED', {
        code: 'INTERRUPTED',
        message: 'the process stopped during this run; open payments are left to the reconciler',
      });
      out.push(
        updateRun(this.#d.db, {
          ...run,
          status: 'FAILED',
          finishedAt: this.#now(),
          error: 'INTERRUPTED: the process stopped during this run',
        }),
      );
    }
    return out;
  }
}
