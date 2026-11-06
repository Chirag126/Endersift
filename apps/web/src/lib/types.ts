/**
 * Shapes of the agent API's JSON (apps/server/src/api/server.ts). Amounts are
 * integer strings (tinybars, neuron): never floats. These are the fields the
 * UI reads; the API may send more.
 */

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export const PAYMENT_STATUSES = [
  'CREATED',
  'AUTHORIZED',
  'REFUSED',
  'SIGNED',
  'SUBMITTED',
  'SETTLED',
  'UNKNOWN',
  'FAILED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type InferenceStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'REFUSED';

export interface Task {
  readonly id: string;
  readonly trigger: 'manual' | 'scheduled';
  readonly watchlist: readonly string[];
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface RunEvent {
  readonly runId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly at: string;
}

export interface Payment {
  readonly id: string;
  readonly runId: string;
  readonly provider: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly capability: string;
  readonly requestUrl: string;
  readonly status: PaymentStatus;
  readonly refusalCode: string | null;
  readonly errorCode: string | null;
  readonly transactionId: string | null;
  readonly settledAt: string | null;
  readonly createdAt: string;
  readonly hashscan: string | null;
}

export interface InferenceCall {
  readonly id: string;
  readonly runId: string | null;
  readonly purpose: string;
  readonly network: string;
  readonly model: string;
  readonly status: InferenceStatus;
  readonly requestId: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly worstCaseNeuron: string | null;
  readonly costNeuron: string | null;
  readonly funding: string;
  readonly teeVerified: boolean | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
}

export interface Provider {
  readonly ensName: string;
  readonly label: string;
  readonly chain: string;
  readonly resolver: string;
  readonly endpoint: string;
  readonly capabilities: readonly string[];
  readonly payTo: string;
  readonly network: string;
  readonly asset: string;
  readonly priceAtomic: string;
  readonly discoveredAt: string;
}

export interface DiscoverySnapshotInfo {
  readonly runId: string;
  readonly parent: string | null;
  readonly blockNumber: string | null;
  readonly observedAt: string;
}

export interface ProvidersResponse {
  readonly providers: readonly Provider[];
  readonly snapshot: DiscoverySnapshotInfo | null;
  /** From the committed deployment records, not from a run (D-066); absent on older servers. */
  readonly identity?: Erc8004Identity | null;
  readonly ensSetups?: EnsSetups | null;
}

export interface TasksResponse {
  readonly tasks: readonly Task[];
  readonly queue: { readonly running: string | null; readonly pending: number };
}

export interface TaskDetail {
  readonly task: Task;
  readonly summary: RunSummary;
  readonly payments: readonly Payment[];
  readonly inference: readonly InferenceCall[];
  readonly events: number;
  readonly report: boolean;
  readonly audit: readonly AuditInfo[];
  /** Payments that waited for the owner (D-066); absent on older servers. */
  readonly approvals?: readonly PaymentApproval[];
}

export const AUDIT_STATUSES = [
  'SUBMITTING',
  'SUBMITTED',
  'CONFIRMED',
  'UNKNOWN',
  'FAILED',
] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

/** One message on the HCS audit topic (D-057). */
export interface AuditInfo {
  readonly kind: 'settlement' | 'task';
  readonly paymentId: string | null;
  readonly topicId: string;
  readonly status: AuditStatus;
  readonly sequenceNumber: string | null;
  readonly consensusTimestamp: string | null;
  readonly transactionId: string;
  readonly hashscan: string;
  readonly payloadSha256: string;
  readonly error: string | null;
}

/** Today's x402 payments this server's database does not record, read from the Mirror Node (D-062). */
export interface OutsideSpend {
  readonly atomic: string;
  readonly count: number;
  readonly readAt: string;
}

export interface PaymentsResponse {
  readonly payments: readonly Payment[];
  readonly today: {
    readonly day: string;
    /** Includes `outside`. */
    readonly committedAtomic: string;
    /** Absent on older servers; null before the first reading today. */
    readonly outside?: OutsideSpend | null;
  };
}

export interface InferenceResponse {
  readonly calls: readonly InferenceCall[];
  readonly today: { readonly day: string; readonly spentNeuron: string; readonly calls: number };
}

export interface EvidenceFile {
  readonly path: string;
  readonly track: string;
  readonly kind: string;
  readonly verified: boolean | null;
  readonly bytes: number;
}

export interface PublicConfig {
  /** Real networks, or the MOCK harness (nothing real is spent). */
  readonly mode: 'live' | 'mock';
  readonly networks: {
    readonly ens: string;
    readonly hedera: 'testnet' | 'mainnet';
    readonly x402: string;
    readonly zg: string;
  };
  readonly ensParent: string;
  readonly payer: string;
  readonly policy: {
    readonly asset: string;
    readonly maxPerPayment: string;
    readonly maxPerRun: string;
    readonly maxPerDay: string;
    readonly maxPaymentsPerRun: number;
    readonly maxSnapshotAgeSec: number;
    readonly allowedProviders: readonly string[] | null;
    readonly blockedProviders: readonly string[];
    readonly allowedCapabilities: readonly string[] | null;
    /** The owner's kill switch, enforced by the firewall. */
    readonly paymentsPaused: boolean;
    /** Where the limits come from: the env file, or a version the owner saved. */
    readonly source: PolicySource;
    readonly version: number | null;
    /** D-066; absent on older servers (autonomous, no caps). */
    readonly approvalMode?: ApprovalMode;
    readonly approvalAboveTinybars?: string;
    readonly providerDailyCaps?: Readonly<Record<string, string>>;
  };
  /** How long an approval request waits before it expires (D-066). */
  readonly approvals?: { readonly timeoutSec: number };
  /** The account the agent's brief is sold to, or null when it is not for sale (D-066). */
  readonly earnings?: { readonly account: string } | null;
  /** The HCS audit topic (D-057), or null when the server posts no audit messages. */
  readonly hcs: { readonly topicId: string } | null;
  /** The provider host's /health the web app asks from the browser to wake it (D-085). */
  readonly providerWake?: { readonly url: string } | null;
  /** How this server is hosted (D-062); absent on older servers and the mock. */
  readonly deployment?: {
    /** The host wipes the database when it restarts (Render free plan). */
    readonly ephemeralDatabase: boolean;
    /** A daily brief comes from the server's configuration (DAILY_BRIEF_*). */
    readonly seededBrief: boolean;
    /** Minutes after its time during which a missed daily brief still starts; null = all day. */
    readonly catchUpWindowMin: number | null;
  };
  readonly zg: {
    readonly model: string;
    /**
     * Why 0G inference is unavailable since the server started (the model is not in the
     * catalog, or the catalog could not be read), or null; absent on older servers (D-079).
     */
    readonly unavailable?: string | null;
    readonly capNeuron: string;
    readonly dailyCapNeuron: string;
    readonly planTokens: number;
    readonly analyzeTokens: number;
    readonly maxPurchases: number;
  };
  /** The voice task (D-076): speech to text on 0G; absent on older servers. */
  readonly voice?: {
    readonly model: string;
    readonly enabled: boolean;
    readonly reason: string | null;
  };
}

export interface Health {
  readonly status: string;
  readonly migration: number;
  readonly queue: { readonly running: string | null; readonly pending: number };
  /** Payments waiting for the owner (D-066); absent on older servers. */
  readonly approvals?: { readonly pending: number };
}

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** One payment that waited for the owner's decision (D-066). */
export interface PaymentApproval {
  readonly id: string;
  readonly runId: string;
  readonly paymentId: string;
  readonly provider: string;
  readonly capability: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly requestUrl: string;
  /** The threshold in force when it was asked (tinybars). */
  readonly threshold: string;
  readonly status: ApprovalStatus;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: 'owner' | 'timeout' | 'restart' | null;
  readonly note: string | null;
}

export interface ApprovalsResponse {
  readonly mode: ApprovalMode;
  readonly aboveTinybars: string;
  readonly approvals: readonly PaymentApproval[];
}

/** GET /api/earnings: sales of the agent's brief, read from the Mirror Node (D-066). */
export type EarningsResponse =
  | { readonly enabled: false; readonly account: null }
  | {
      readonly enabled: true;
      readonly account: string;
      readonly windowDays: number;
      readonly tinybars: string;
      /** Paid by anyone other than this agent's own payer. */
      readonly outsideTinybars: string;
      readonly sales: readonly {
        readonly transactionId: string;
        readonly consensusTimestamp: string;
        readonly tinybars: string;
        readonly buyer: string | null;
        readonly fromOwnPayer: boolean;
        readonly hashscan: string | null;
      }[];
      readonly readAt: string;
    };

/** ERC-8004 identities from the committed deployment record (D-066). */
export interface Erc8004Identity {
  readonly chainId: number;
  readonly identityRegistry: string;
  readonly agents: Readonly<
    Record<string, { readonly agentId: string; readonly agentURI: string; readonly owner: string }>
  >;
}

export const ENS_SETUP_KINDS = ['expiring', 'transferable', 'locked', 'wildcard', 'alias'] as const;
export type EnsSetupKind = (typeof ENS_SETUP_KINDS)[number];

/** ENSv2 subname setups from the committed deployment record (D-066). */
export interface EnsSetups {
  readonly parent: string;
  readonly subregistry: string;
  readonly parentResolver: string;
  readonly setups: readonly {
    readonly kind: EnsSetupKind;
    readonly name: string;
    readonly expiry: string | null;
    readonly owner: string | null;
    readonly proof: string;
  }[];
}

export type PolicySource = 'env' | 'owner';

export const APPROVAL_MODES = ['autonomous', 'human'] as const;
/** Autonomous (the default): the firewall decides alone. Human: payments above the threshold wait for the owner (D-066). */
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export interface OwnerLimits {
  readonly maxPerPayment: string;
  readonly maxPerRun: string;
  readonly maxPerDay: string;
  readonly maxPaymentsPerRun: number;
  readonly paymentsPaused: boolean;
  /** Absent on servers before D-066 (treated as autonomous). */
  readonly approvalMode?: ApprovalMode;
  /** Tinybars; in human mode, payments above this wait for the owner (0 = every payment). */
  readonly approvalAboveTinybars?: string;
  /** ENS name → tinybars per UTC day with that provider, across all tasks. */
  readonly providerDailyCaps?: Readonly<Record<string, string>>;
}

export interface PolicyVersionInfo extends OwnerLimits {
  readonly version: number;
  readonly reason: string | null;
  readonly changedBy: string;
  readonly createdAt: string;
}

/** GET /api/policy */
export interface PolicyResponse {
  readonly effective: OwnerLimits;
  readonly source: PolicySource;
  readonly version: number | null;
  readonly updatedAt: string | null;
  readonly reason: string | null;
  readonly clamped: readonly string[];
  readonly ceiling: OwnerLimits;
  /** Paused by the server's own setting (X402_PAYMENTS_PAUSED): not liftable here (D-062). */
  readonly serverPaused?: boolean;
  readonly fixed: {
    readonly network: string;
    readonly asset: string;
    readonly payer: string;
    readonly maxSnapshotAgeSec: number;
    readonly allowedProviders: readonly string[] | null;
    readonly blockedProviders: readonly string[];
    readonly allowedCapabilities: readonly string[] | null;
  };
  readonly enforcement: {
    readonly firewall: boolean;
    readonly killSwitch: boolean;
    readonly ensPublished: boolean;
    /** Enforced by the server (D-066); absent on older servers. */
    readonly providerCaps?: boolean;
    readonly approvals?: boolean;
  };
  readonly history: readonly PolicyVersionInfo[];
}

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

/** Decided by the server from the run's events (the UI never promotes a run). */
export interface RunSummary {
  readonly environment: 'live' | 'mock';
  readonly environmentSource: 'recorded' | 'inferred';
  readonly origin: string | null;
  readonly policyVersion: number | null;
  readonly stages: readonly StageResult[];
  readonly verdict: Verdict;
  readonly gaps: readonly string[];
  readonly failureCode: string | null;
}

export interface RunRecord {
  readonly task: Task;
  readonly summary: RunSummary;
  readonly events: number;
  readonly payments: readonly {
    readonly id: string;
    readonly provider: string;
    readonly amountAtomic: string;
    readonly status: PaymentStatus;
    readonly refusalCode: string | null;
    readonly transactionId: string | null;
    readonly hashscan: string | null;
  }[];
  readonly inference: readonly {
    readonly id: string;
    readonly purpose: string;
    readonly status: InferenceStatus;
    readonly requestId: string | null;
    readonly costNeuron: string | null;
    readonly funding: string;
    readonly teeVerified: boolean | null;
  }[];
  readonly audit: readonly AuditInfo[];
}

export interface RunsResponse {
  readonly mode: 'live' | 'mock';
  readonly runs: readonly RunRecord[];
}

export interface LogEntry {
  readonly id: number;
  readonly runId: string;
  readonly seq: number;
  readonly type: string;
  readonly stage: Stage | null;
  readonly severity: Severity;
  readonly at: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ScheduleDelta {
  readonly previousRunId: string;
  readonly previousAt: string;
  readonly added: readonly string[];
  readonly gone: readonly string[];
  readonly changed: readonly {
    readonly id: string;
    readonly from: string | null;
    readonly to: string | null;
  }[];
  readonly unchanged: number;
}

export interface ScheduleInfo {
  readonly id: string;
  readonly watchlist: readonly string[];
  /** Tinybars. */
  readonly budget: string;
  /** UTC, HH:MM. */
  readonly runAfter: string;
  readonly enabled: boolean;
  readonly lastSkip: string | null;
  readonly lastSkipAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt: string | null;
  readonly runs: readonly {
    readonly day: string;
    readonly runId: string;
    readonly status: RunStatus | null;
    readonly verdict: Verdict | null;
    readonly delta: ScheduleDelta | null;
  }[];
}

export interface SchedulesResponse {
  readonly now: string;
  readonly max: number;
  readonly schedules: readonly ScheduleInfo[];
}

export interface LogsResponse {
  readonly entries: readonly LogEntry[];
  readonly next: number | null;
  readonly total: number;
}
