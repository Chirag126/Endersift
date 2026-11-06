/**
 * Domain entities shared by the server, the agent and the UI. Each schema is
 * strict (unknown keys are rejected) so that persisted rows and API payloads
 * cannot smuggle fields past validation.
 */
import { z } from 'zod';
import {
  AtomicAmount,
  ChainName,
  EnsName,
  EvmAddress,
  HederaAccountId,
  HederaNetwork,
  HederaTransactionId,
  HttpsUrl,
  IsoTimestamp,
  PositiveAtomicAmount,
  ProviderEndpoint,
  Slug,
  Uuid,
  ZgNetwork,
} from './primitives.ts';

/** A paid data provider, as discovered from its ENS records (never hard-coded). */
export const ProviderAgent = z
  .object({
    ensName: EnsName,
    label: Slug,
    chain: ChainName,
    resolver: EvmAddress,
    endpoint: ProviderEndpoint,
    capabilities: z.array(Slug).min(1).max(32),
    payTo: HederaAccountId,
    network: HederaNetwork,
    /** Settlement asset: 0.0.0 = HBAR, otherwise an HTS token ID. */
    asset: HederaAccountId,
    priceAtomic: PositiveAtomicAmount,
    discoveredAt: IsoTimestamp,
  })
  .strict();
export type ProviderAgent = z.infer<typeof ProviderAgent>;

export const RunTrigger = z.enum(['manual', 'scheduled']);
export const RunStatus = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);

/** One agent run: a watchlist in, a brief out. */
export const Run = z
  .object({
    id: Uuid,
    trigger: RunTrigger,
    watchlist: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
    status: RunStatus,
    createdAt: IsoTimestamp,
    startedAt: IsoTimestamp.nullable(),
    finishedAt: IsoTimestamp.nullable(),
    error: z.string().max(2000).nullable(),
  })
  .strict();
export type Run = z.infer<typeof Run>;
export type RunStatus = z.infer<typeof RunStatus>;

/** Allowed run status changes; must equal SQL_RUN_TRANSITIONS in the server migrations. */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export const RunEventType = z.enum([
  'RUN_STARTED',
  'PROVIDERS_DISCOVERED',
  'INFERENCE_CALLED',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_REFUSED',
  'PAYMENT_SETTLED',
  'PAYMENT_UNKNOWN',
  'DATA_FETCHED',
  'REPORT_WRITTEN',
  'RUN_FAILED',
  'RUN_FINISHED',
  // migration 5 (orchestrator, D-046)
  'CATALOG_READ',
  'PLAN_CREATED',
  'PURCHASE_SKIPPED',
  'PAYMENT_FAILED',
  'DATA_REJECTED',
  'ANALYSIS_COMPLETED',
  // migration 9 (approvals, D-066)
  'PAYMENT_APPROVAL_REQUESTED',
  'PAYMENT_APPROVAL_DECIDED',
]);
export type RunEventType = z.infer<typeof RunEventType>;

/** Append-only timeline entry; payload is JSON and validated by its type's producer. */
export const RunEvent = z
  .object({
    runId: Uuid,
    seq: z.number().int().nonnegative(),
    type: RunEventType,
    payload: z.record(z.string(), z.unknown()),
    at: IsoTimestamp,
  })
  .strict();
export type RunEvent = z.infer<typeof RunEvent>;

export const PaymentStatus = z.enum([
  'CREATED',
  'AUTHORIZED',
  'REFUSED',
  'SIGNED',
  'SUBMITTED',
  'SETTLED',
  'UNKNOWN',
  'FAILED',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

/**
 * Statuses whose amount counts as committed spend for the firewall budgets:
 * money that is moving, has moved, or may have moved (UNKNOWN).
 */
export const COMMITTED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'AUTHORIZED',
  'SIGNED',
  'SUBMITTED',
  'SETTLED',
  'UNKNOWN',
];

/** One attempt to pay one provider for one request, tracked through settlement. */
export const PaymentIntent = z
  .object({
    id: Uuid,
    runId: Uuid,
    provider: EnsName,
    payTo: HederaAccountId,
    network: HederaNetwork,
    asset: HederaAccountId,
    amountAtomic: PositiveAtomicAmount,
    /** sha256 of (run, provider, capability, request URL): one intent per purchase (D-042). */
    idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex digest'),
    capability: Slug,
    /** The URL being paid for (checked against the ENS endpoint by the firewall). */
    requestUrl: z.string().min(1).max(2048),
    status: PaymentStatus,
    /** Firewall reason code when REFUSED. */
    refusalCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
      .nullable(),
    /** Known before submission (generated from the facilitator fee payer). */
    transactionId: HederaTransactionId.nullable(),
    facilitator: HttpsUrl.nullable(),
    /** Why a payment FAILED or is stuck in UNKNOWN (e.g. TX_EXPIRED_NOT_FOUND, SETTLEMENT_MISMATCH). */
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
      .nullable(),
    settledAt: IsoTimestamp.nullable(),
    /** Mirror Node reconciliation attempts for SUBMITTED / UNKNOWN payments. */
    reconcileAttempts: z.number().int().nonnegative(),
    lastCheckedAt: IsoTimestamp.nullable(),
    createdAt: IsoTimestamp,
    updatedAt: IsoTimestamp,
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.status === 'SETTLED' && p.settledAt === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a SETTLED payment needs settledAt',
        path: ['settledAt'],
      });
    }
    if (p.status === 'REFUSED' && p.refusalCode === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a REFUSED payment needs a refusal code',
        path: ['refusalCode'],
      });
    }
    if (
      ['SIGNED', 'SUBMITTED', 'SETTLED', 'UNKNOWN'].includes(p.status) &&
      p.transactionId === null
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `a ${p.status} payment needs its transaction ID`,
        path: ['transactionId'],
      });
    }
  });
export type PaymentIntent = z.infer<typeof PaymentIntent>;

/**
 * Allowed payment transitions. The rule that matters most: once a payment is
 * SUBMITTED its outcome can only become SETTLED, UNKNOWN or FAILED, and
 * UNKNOWN can only be reconciled to SETTLED or FAILED. It can never go back to
 * SIGNED, so a payment with an unknown outcome is never re-signed (D-018).
 */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  CREATED: ['AUTHORIZED', 'REFUSED'],
  AUTHORIZED: ['SIGNED', 'FAILED'],
  SIGNED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['SETTLED', 'UNKNOWN', 'FAILED'],
  UNKNOWN: ['SETTLED', 'FAILED'],
  REFUSED: [],
  SETTLED: [],
  FAILED: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export const isTerminalPayment = (s: PaymentStatus): boolean => PAYMENT_TRANSITIONS[s].length === 0;

/** TRANSCRIBE: a spoken watchlist turned into text on 0G (D-076). */
export const InferencePurpose = z.enum([
  'PLAN',
  'SELECT',
  'ANALYZE',
  'REPORT',
  'PROBE',
  'TRANSCRIBE',
]);
export const FundingSource = z.enum(['credits', 'deposit', 'mixed', 'none', 'unknown']);
/**
 * Inference call lifecycle (D-040). A call is reserved as PENDING (with its
 * worst-case cost, under the daily cap) before it is sent, then settled:
 * SUCCEEDED (billed, usable), FAILED (Router error, or billed but unusable
 * output), UNKNOWN (transport error or timeout: never retried, counted at the
 * worst case). REFUSED rows are refusals before sending (no cost).
 */
export const InferenceStatus = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'REFUSED']);
export type InferenceStatus = z.infer<typeof InferenceStatus>;

/** Allowed status changes; must equal SQL_INFERENCE_TRANSITIONS in the server migrations. */
export const INFERENCE_TRANSITIONS: Readonly<Record<InferenceStatus, readonly InferenceStatus[]>> =
  {
    PENDING: ['SUCCEEDED', 'FAILED', 'UNKNOWN'],
    UNKNOWN: ['SUCCEEDED', 'FAILED'],
    SUCCEEDED: [],
    FAILED: [],
    REFUSED: [],
  };

/** One 0G inference call, with the Router's own billing and funding split. */
export const InferenceCall = z
  .object({
    id: Uuid,
    runId: Uuid.nullable(),
    purpose: InferencePurpose,
    network: ZgNetwork,
    model: z.string().min(1).max(200),
    status: InferenceStatus,
    requestId: z.string().min(1).max(200).nullable(),
    provider: EvmAddress.nullable(),
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    /** Pre-call worst case from catalog prices: what the daily cap reserves. */
    worstCaseNeuron: AtomicAmount.nullable(),
    costNeuron: AtomicAmount.nullable(),
    creditUsedNeuron: AtomicAmount.nullable(),
    depositUsedNeuron: AtomicAmount.nullable(),
    funding: FundingSource,
    teeVerified: z.boolean().nullable(),
    errorCode: z.string().max(100).nullable(),
    createdAt: IsoTimestamp,
    settledAt: IsoTimestamp.nullable(),
    /** When the row was matched against the Router's usage history. */
    reconciledAt: IsoTimestamp.nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.status === 'SUCCEEDED' && (c.requestId === null || c.costNeuron === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'a SUCCEEDED call needs its request ID and cost',
        path: ['requestId'],
      });
    }
    if ((c.status === 'PENDING' || c.status === 'UNKNOWN') && c.worstCaseNeuron === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'a PENDING or UNKNOWN call needs its reserved worst case',
        path: ['worstCaseNeuron'],
      });
    }
    if (c.funding === 'credits' && (c.creditUsedNeuron === null || c.creditUsedNeuron === '0')) {
      ctx.addIssue({
        code: 'custom',
        message: 'credit funding requires credit_used > 0',
        path: ['funding'],
      });
    }
  });
export type InferenceCall = z.infer<typeof InferenceCall>;

export const BalanceSnapshotTrigger = z.enum(['job', 'manual']);

/**
 * One read of the Router's /account/balance (D-039: these figures are the
 * Router float, refilled from the Payment Layer; they are not the whole
 * deposit). A field the Router omitted is null.
 */
export const ZgBalanceSnapshot = z
  .object({
    id: Uuid,
    network: ZgNetwork,
    address: EvmAddress,
    depositBalanceNeuron: AtomicAmount.nullable(),
    creditBalanceNeuron: AtomicAmount.nullable(),
    pendingChargeNeuron: AtomicAmount.nullable(),
    totalBalanceNeuron: AtomicAmount.nullable(),
    balanceNeuron: AtomicAmount.nullable(),
    trigger: BalanceSnapshotTrigger,
    takenAt: IsoTimestamp,
  })
  .strict();
export type ZgBalanceSnapshot = z.infer<typeof ZgBalanceSnapshot>;

/** The brief a run produces. */
export const Report = z
  .object({
    runId: Uuid,
    markdown: z.string().min(1).max(200_000),
    createdAt: IsoTimestamp,
  })
  .strict();
export type Report = z.infer<typeof Report>;
