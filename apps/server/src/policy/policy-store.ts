/**
 * The owner's spending policy, persisted (D-052).
 *
 * Layers, from outermost:
 *   ceiling    the env configuration (X402_*): fixed at start-up. The signer's
 *              own second layer (D-017) is built from it, so nothing here can
 *              ever exceed it.
 *   owner      append-only versions in `policy_versions` (migration 6), saved
 *              from the UI with the access code. They may only TIGHTEN the
 *              ceiling: every amount is <= its env value. The latest version
 *              is in force; earlier versions are the audit trail.
 *   effective  ceiling + latest owner version (re-clamped to the ceiling, in
 *              case the env was lowered after the version was saved).
 *
 * The firewall (`authorize`) receives the effective policy for every purchase,
 * so the kill switch and lowered limits are enforced server-side. Nothing here
 * is published to ENS; the UI says so.
 */
import type { DatabaseSync } from 'node:sqlite';
import { policyProblems, type SpendingPolicy } from '@agent-economy/policy';

/**
 * Who approves a payment the firewall allowed (D-066). `autonomous` (the
 * default): the agent pays on its own. `human`: a payment above
 * `aboveTinybars` waits for the owner, and is never signed without a yes.
 */
export const APPROVAL_MODES = ['autonomous', 'human'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export interface ApprovalRule {
  readonly mode: ApprovalMode;
  /** In human mode, payments strictly above this amount need approval (0 = every payment). */
  readonly aboveTinybars: bigint;
}

export const AUTONOMOUS: ApprovalRule = { mode: 'autonomous', aboveTinybars: 0n };

/** True when a payment of `amount` must wait for the owner under `rule`. Pure. */
export const needsApproval = (rule: ApprovalRule, amount: bigint): boolean =>
  rule.mode === 'human' && amount > rule.aboveTinybars;

/** The part of the policy the owner may change from the UI. */
export interface OwnerLimits {
  readonly maxPerPayment: bigint;
  readonly maxPerRun: bigint;
  readonly maxPerDay: bigint;
  readonly maxPaymentsPerRun: number;
  readonly paymentsPaused: boolean;
  /** Approval mode and threshold (D-066). */
  readonly approvalMode: ApprovalMode;
  readonly approvalAboveTinybars: bigint;
  /** ENS name → most tinybars per UTC day to that provider (D-066); {} = none. */
  readonly providerDailyCaps: Readonly<Record<string, bigint>>;
}

export interface PolicyVersion extends OwnerLimits {
  readonly version: number;
  readonly reason: string | null;
  readonly changedBy: 'owner';
  readonly createdAt: string;
}

export interface EffectivePolicy {
  readonly policy: SpendingPolicy;
  /** Who approves payments the firewall allows (autonomous until the owner chooses otherwise). */
  readonly approval: ApprovalRule;
  /** 'env' until the owner saves a version. */
  readonly source: 'env' | 'owner';
  readonly version: number | null;
  /** Fields the env ceiling forced below the saved version (env lowered later). */
  readonly clamped: readonly string[];
}

export class PolicyValidationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid policy: ${problems.join('; ')}`);
    this.name = 'PolicyValidationError';
    this.problems = problems;
  }
}

export class PolicyConflictError extends Error {
  readonly current: number | null;
  constructor(current: number | null) {
    super(
      `the policy changed since it was loaded (now version ${current ?? 'none'}); reload and try again`,
    );
    this.name = 'PolicyConflictError';
    this.current = current;
  }
}

const ATOMIC = /^[1-9]\d{0,29}$/;
const NON_NEGATIVE = /^(0|[1-9]\d{0,29})$/;
const ENS_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MAX_REASON = 200;
/** Per-provider caps the owner may set (a few providers are discovered, D-066). */
export const MAX_PROVIDER_CAPS = 20;
const UPDATE_KEYS = [
  'maxPerPayment',
  'maxPerRun',
  'maxPerDay',
  'maxPaymentsPerRun',
  'paymentsPaused',
  'approvalMode',
  'approvalAboveTinybars',
  'providerDailyCaps',
  'expectedVersion',
  'reason',
];

/** What a version carries forward when an update leaves the D-066 fields out. */
const DEFAULT_EXTRAS = {
  approvalMode: 'autonomous' as ApprovalMode,
  approvalAboveTinybars: 0n,
  providerDailyCaps: {} as Readonly<Record<string, bigint>>,
};

/** The D-066 fields; an update that leaves them out keeps the version in force. */
type Extras = 'approvalMode' | 'approvalAboveTinybars' | 'providerDailyCaps';
export type OwnerLimitsUpdate = Omit<OwnerLimits, Extras> & Partial<Pick<OwnerLimits, Extras>>;

export interface PolicyUpdate {
  readonly limits: OwnerLimitsUpdate;
  readonly expectedVersion: number | null;
  readonly reason: string | null;
}

/**
 * Parse and validate an update from the UI against the ceiling. Every problem
 * is reported (never only the first). The approval and per-provider fields
 * (D-066) are optional: when left out, `previous` (the version in force) is
 * kept, so an older client cannot reset them by accident. Pure.
 */
export function parsePolicyUpdate(
  body: Record<string, unknown>,
  ceiling: SpendingPolicy,
  previous: Pick<
    OwnerLimits,
    'approvalMode' | 'approvalAboveTinybars' | 'providerDailyCaps'
  > | null = null,
) {
  const problems: string[] = [];
  const extra = Object.keys(body).filter((k) => !UPDATE_KEYS.includes(k));
  if (extra.length > 0) problems.push(`unknown field(s): ${extra.join(', ')}`);

  const amount = (key: 'maxPerPayment' | 'maxPerRun' | 'maxPerDay', max: bigint): bigint | null => {
    const v = body[key];
    if (typeof v !== 'string' || !ATOMIC.test(v)) {
      problems.push(`${key} must be a positive integer string (tinybars)`);
      return null;
    }
    const n = BigInt(v);
    if (n > max) problems.push(`${key} ${v} is above the server ceiling ${max} (env)`);
    return n;
  };
  const maxPerPayment = amount('maxPerPayment', ceiling.maxPerPayment);
  const maxPerRun = amount('maxPerRun', ceiling.maxPerRun);
  const maxPerDay = amount('maxPerDay', ceiling.maxPerDay);
  if (maxPerPayment !== null && maxPerRun !== null && maxPerPayment > maxPerRun)
    problems.push('maxPerPayment must not be above maxPerRun');
  if (maxPerRun !== null && maxPerDay !== null && maxPerRun > maxPerDay)
    problems.push('maxPerRun must not be above maxPerDay');

  const count = body['maxPaymentsPerRun'];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1)
    problems.push('maxPaymentsPerRun must be an integer >= 1');
  else if (count > ceiling.maxPaymentsPerRun)
    problems.push(
      `maxPaymentsPerRun ${count} is above the server ceiling ${ceiling.maxPaymentsPerRun} (env)`,
    );

  const paused = body['paymentsPaused'];
  if (typeof paused !== 'boolean') problems.push('paymentsPaused must be true or false');

  const base = previous ?? DEFAULT_EXTRAS;
  const modeIn = body['approvalMode'];
  let approvalMode = base.approvalMode;
  if (modeIn !== undefined) {
    if (typeof modeIn === 'string' && (APPROVAL_MODES as readonly string[]).includes(modeIn))
      approvalMode = modeIn as ApprovalMode;
    else problems.push('approvalMode must be "autonomous" or "human"');
  }
  const aboveIn = body['approvalAboveTinybars'];
  let approvalAboveTinybars = base.approvalAboveTinybars;
  if (aboveIn !== undefined) {
    if (typeof aboveIn === 'string' && NON_NEGATIVE.test(aboveIn))
      approvalAboveTinybars = BigInt(aboveIn);
    else problems.push('approvalAboveTinybars must be a whole number of tinybars (0 or more)');
  }
  const capsIn = body['providerDailyCaps'];
  let providerDailyCaps: Readonly<Record<string, bigint>> = base.providerDailyCaps;
  if (capsIn !== undefined) {
    if (typeof capsIn !== 'object' || capsIn === null || Array.isArray(capsIn))
      problems.push('providerDailyCaps must be an object of ENS name → tinybars');
    else {
      const entries = Object.entries(capsIn as Record<string, unknown>);
      if (entries.length > MAX_PROVIDER_CAPS)
        problems.push(`at most ${MAX_PROVIDER_CAPS} per-provider caps`);
      const caps: Record<string, bigint> = {};
      for (const [name, v] of entries) {
        if (!ENS_NAME.test(name) || name.length > 255) {
          problems.push(
            `providerDailyCaps: ${JSON.stringify(name.slice(0, 80))} is not an ENS name`,
          );
          continue;
        }
        if (typeof v !== 'string' || !ATOMIC.test(v)) {
          problems.push(`providerDailyCaps[${name}] must be a positive integer string (tinybars)`);
          continue;
        }
        const cap = BigInt(v);
        if (maxPerDay !== null && cap > maxPerDay)
          problems.push(`providerDailyCaps[${name}] must not be above maxPerDay`);
        caps[name] = cap;
      }
      providerDailyCaps = caps;
    }
  }

  const expected = body['expectedVersion'];
  if (expected !== null && (typeof expected !== 'number' || !Number.isInteger(expected)))
    problems.push('expectedVersion must be the version you loaded, or null');

  const reason = body['reason'];
  if (reason !== undefined && reason !== null && typeof reason !== 'string')
    problems.push('reason must be text');
  const reasonText = typeof reason === 'string' ? reason.trim() : '';
  if (reasonText.length > MAX_REASON) problems.push(`reason is at most ${MAX_REASON} characters`);

  if (problems.length > 0) return { ok: false as const, problems };
  const update: PolicyUpdate = {
    limits: {
      maxPerPayment: maxPerPayment ?? 0n,
      maxPerRun: maxPerRun ?? 0n,
      maxPerDay: maxPerDay ?? 0n,
      maxPaymentsPerRun: count as number,
      paymentsPaused: paused as boolean,
      approvalMode,
      approvalAboveTinybars,
      providerDailyCaps,
    },
    expectedVersion: expected as number | null,
    reason: reasonText === '' ? null : reasonText,
  };
  return { ok: true as const, update };
}

type Row = Record<string, unknown>;

/** The stored caps JSON ({name: "tinybars"}) as bigints; anything malformed is dropped. */
function capsFromJson(text: unknown): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  try {
    const raw = JSON.parse(String(text ?? '{}')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (ENS_NAME.test(k) && typeof v === 'string' && ATOMIC.test(v)) out[k] = BigInt(v);
  } catch {
    // the column has a json_valid CHECK; nothing to recover
  }
  return out;
}

const capsToJson = (caps: Readonly<Record<string, bigint>>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(caps)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, v.toString()]),
    ),
  );

/** Caps as strings, for the API. */
export const capsView = (caps: Readonly<Record<string, bigint>>): Record<string, string> =>
  Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.toString()]));

const versionFromRow = (r: Row): PolicyVersion => ({
  version: Number(r['version']),
  maxPerPayment: BigInt(String(r['max_per_payment'])),
  maxPerRun: BigInt(String(r['max_per_run'])),
  maxPerDay: BigInt(String(r['max_per_day'])),
  maxPaymentsPerRun: Number(r['max_payments_per_run']),
  paymentsPaused: Number(r['payments_paused']) === 1,
  approvalMode: r['approval_mode'] === 'human' ? 'human' : 'autonomous',
  approvalAboveTinybars: BigInt(String(r['approval_above'] ?? '0')),
  providerDailyCaps: capsFromJson(r['provider_caps']),
  reason: typeof r['reason'] === 'string' ? r['reason'] : null,
  changedBy: 'owner',
  createdAt: String(r['created_at']),
});

export class PolicyStore {
  readonly #db: DatabaseSync;
  readonly #ceiling: SpendingPolicy;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, ceiling: SpendingPolicy, now: () => Date = () => new Date()) {
    const problems = policyProblems(ceiling);
    if (problems.length > 0) throw new PolicyValidationError(problems);
    this.#db = db;
    this.#ceiling = ceiling;
    this.#now = now;
  }

  /** The env configuration: the most any owner version may allow. */
  get ceiling(): SpendingPolicy {
    return this.#ceiling;
  }

  latest(): PolicyVersion | null {
    const row = this.#db
      .prepare('SELECT * FROM policy_versions ORDER BY version DESC LIMIT 1')
      .get() as Row | undefined;
    return row === undefined ? null : versionFromRow(row);
  }

  history(limit = 20): PolicyVersion[] {
    const n = Math.max(1, Math.min(limit, 100));
    return (
      this.#db
        .prepare('SELECT * FROM policy_versions ORDER BY version DESC LIMIT ?')
        .all(n) as Row[]
    ).map(versionFromRow);
  }

  /** The policy in force now. Read for every run and before every purchase. */
  effective(): EffectivePolicy {
    const v = this.latest();
    if (v === null)
      return {
        policy: { ...this.#ceiling, paymentsPaused: this.#ceiling.paymentsPaused === true },
        approval: AUTONOMOUS,
        source: 'env',
        version: null,
        clamped: [],
      };
    const c = this.#ceiling;
    const clamped: string[] = [];
    const cap = (name: string, value: bigint, max: bigint) => {
      if (value <= max) return value;
      clamped.push(name);
      return max;
    };
    const perDay = cap('maxPerDay', v.maxPerDay, c.maxPerDay);
    const perRun = cap('maxPerRun', v.maxPerRun, perDay < c.maxPerRun ? perDay : c.maxPerRun);
    const perPayment = cap(
      'maxPerPayment',
      v.maxPerPayment,
      perRun < c.maxPerPayment ? perRun : c.maxPerPayment,
    );
    let count = v.maxPaymentsPerRun;
    if (count > c.maxPaymentsPerRun) {
      clamped.push('maxPaymentsPerRun');
      count = c.maxPaymentsPerRun;
    }
    // a per-provider cap is never above the daily limit in force
    const caps: Record<string, bigint> = {};
    let capClamped = false;
    for (const [name, cap] of Object.entries(v.providerDailyCaps)) {
      if (cap > perDay) capClamped = true;
      caps[name] = cap > perDay ? perDay : cap;
    }
    if (capClamped) clamped.push('providerDailyCaps');
    return {
      policy: {
        ...c,
        maxPerPayment: perPayment,
        maxPerRun: perRun,
        maxPerDay: perDay,
        maxPaymentsPerRun: count,
        // the server's kill switch (X402_PAYMENTS_PAUSED) wins over a saved "not paused"
        paymentsPaused: c.paymentsPaused === true || v.paymentsPaused,
        ...(Object.keys(caps).length > 0 ? { providerDailyCaps: caps } : {}),
      },
      approval: { mode: v.approvalMode, aboveTinybars: v.approvalAboveTinybars },
      source: 'owner',
      version: v.version,
      clamped,
    };
  }

  /**
   * Save a new version. Compare-and-set on the version the owner loaded, so
   * two tabs cannot silently overwrite each other. Validated again here
   * (the UI's checks are a convenience, not the boundary).
   */
  save(update: PolicyUpdate): PolicyVersion {
    // fields the update leaves out keep the version in force (D-066)
    const previous = this.latest();
    const l: OwnerLimits = {
      ...DEFAULT_EXTRAS,
      ...(previous === null
        ? {}
        : {
            approvalMode: previous.approvalMode,
            approvalAboveTinybars: previous.approvalAboveTinybars,
            providerDailyCaps: previous.providerDailyCaps,
          }),
      ...update.limits,
    };
    const candidate: SpendingPolicy = {
      ...this.#ceiling,
      maxPerPayment: l.maxPerPayment,
      maxPerRun: l.maxPerRun,
      maxPerDay: l.maxPerDay,
      maxPaymentsPerRun: l.maxPaymentsPerRun,
      paymentsPaused: l.paymentsPaused,
      providerDailyCaps: l.providerDailyCaps,
    };
    const problems = policyProblems(candidate);
    if (l.maxPerPayment > this.#ceiling.maxPerPayment) problems.push('maxPerPayment above ceiling');
    if (l.maxPerRun > this.#ceiling.maxPerRun) problems.push('maxPerRun above ceiling');
    if (l.maxPerDay > this.#ceiling.maxPerDay) problems.push('maxPerDay above ceiling');
    if (l.maxPaymentsPerRun > this.#ceiling.maxPaymentsPerRun)
      problems.push('maxPaymentsPerRun above ceiling');
    if (!(APPROVAL_MODES as readonly string[]).includes(l.approvalMode))
      problems.push('approvalMode must be autonomous or human');
    if (l.approvalAboveTinybars < 0n) problems.push('approvalAboveTinybars must not be negative');
    for (const [name, cap] of Object.entries(l.providerDailyCaps))
      if (cap > l.maxPerDay) problems.push(`providerDailyCaps[${name}] above maxPerDay`);
    if (problems.length > 0) throw new PolicyValidationError(problems);

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.latest()?.version ?? null;
      if (current !== update.expectedVersion) throw new PolicyConflictError(current);
      const version = (current ?? 0) + 1;
      this.#db
        .prepare(
          `INSERT INTO policy_versions (version, max_per_payment, max_per_run, max_per_day, max_payments_per_run, payments_paused, approval_mode, approval_above, provider_caps, reason, changed_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', ?)`,
        )
        .run(
          version,
          l.maxPerPayment.toString(),
          l.maxPerRun.toString(),
          l.maxPerDay.toString(),
          l.maxPaymentsPerRun,
          l.paymentsPaused ? 1 : 0,
          l.approvalMode,
          l.approvalAboveTinybars.toString(),
          capsToJson(l.providerDailyCaps),
          update.reason,
          this.#now().toISOString(),
        );
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    const saved = this.latest();
    if (saved === null) throw new Error('policy version was not saved');
    return saved;
  }
}

/** The policy as the API shows it: amounts as strings, the source and the ceiling. */
export function policyView(store: PolicyStore, historyLimit = 10): Record<string, unknown> {
  const e = store.effective();
  const latest = store.latest();
  const c = store.ceiling;
  const p = e.policy;
  const limits = (x: OwnerLimits) => ({
    maxPerPayment: x.maxPerPayment.toString(),
    maxPerRun: x.maxPerRun.toString(),
    maxPerDay: x.maxPerDay.toString(),
    maxPaymentsPerRun: x.maxPaymentsPerRun,
    paymentsPaused: x.paymentsPaused,
    approvalMode: x.approvalMode,
    approvalAboveTinybars: x.approvalAboveTinybars.toString(),
    providerDailyCaps: capsView(x.providerDailyCaps),
  });
  return {
    effective: limits({
      ...p,
      paymentsPaused: p.paymentsPaused === true,
      approvalMode: e.approval.mode,
      approvalAboveTinybars: e.approval.aboveTinybars,
      providerDailyCaps: p.providerDailyCaps ?? {},
    }),
    source: e.source,
    version: e.version,
    updatedAt: latest?.createdAt ?? null,
    reason: latest?.reason ?? null,
    clamped: e.clamped,
    // the env sets no approval or per-provider cap: those can only be added, never forced off
    ceiling: limits({
      ...c,
      paymentsPaused: c.paymentsPaused === true,
      ...DEFAULT_EXTRAS,
      providerDailyCaps: c.providerDailyCaps ?? {},
    }),
    /** X402_PAYMENTS_PAUSED: paused by the server, not liftable from the UI (D-062). */
    serverPaused: c.paymentsPaused === true,
    fixed: {
      network: p.network,
      asset: p.asset,
      payer: p.payer,
      maxSnapshotAgeSec: Math.round(p.maxSnapshotAgeMs / 1000),
      allowedProviders: p.allowedProviders,
      blockedProviders: p.blockedProviders,
      allowedCapabilities: p.allowedCapabilities,
    },
    // what enforces it, stated plainly (D-052)
    enforcement: {
      firewall: true,
      killSwitch: true,
      providerCaps: true,
      approvals: true,
      ensPublished: false,
    },
    history: store.history(historyLimit).map((v) => ({
      version: v.version,
      ...limits(v),
      reason: v.reason,
      changedBy: v.changedBy,
      createdAt: v.createdAt,
    })),
  };
}
