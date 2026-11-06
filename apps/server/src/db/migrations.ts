/**
 * Schema migrations, applied in order and never edited once released (the
 * runner stores a SHA-256 of each and refuses a changed one). Add a new
 * migration instead.
 *
 * Conventions:
 *  - STRICT tables; money as TEXT canonical integer strings (exact, no float).
 *  - Enum columns carry CHECK constraints that mirror the zod schemas in
 *    packages/core/src/domain (a test keeps them in sync).
 *  - The payment state machine is enforced by triggers as well as in code:
 *    an UNKNOWN or submitted payment can never go back to SIGNED, and a
 *    transaction ID, once recorded, can never change (D-018, D-030).
 *  - Runs move only along SQL_RUN_TRANSITIONS; their events are append-only,
 *    gapless and closed once the run finishes (migration 5, D-046).
 *  - Inference calls follow the same pattern (D-040): rows are born PENDING
 *    (reserved under the daily cap) or REFUSED, move only along
 *    SQL_INFERENCE_TRANSITIONS, and a recorded cost or request ID never changes.
 */

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

const RUN_STATUS = `'QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'`;
const PAYMENT_STATUS = `'CREATED','AUTHORIZED','REFUSED','SIGNED','SUBMITTED','SETTLED','UNKNOWN','FAILED'`;
const HEDERA_NETWORK = `'hedera:testnet','hedera:mainnet'`;
const RUN_EVENT_TYPE = `'RUN_STARTED','PROVIDERS_DISCOVERED','INFERENCE_CALLED','PAYMENT_AUTHORIZED','PAYMENT_REFUSED','PAYMENT_SETTLED','PAYMENT_UNKNOWN','DATA_FETCHED','REPORT_WRITTEN','RUN_FAILED','RUN_FINISHED'`;

/** Migration 5 (orchestrator, D-046): the event types the full pipeline records. */
const RUN_EVENT_TYPE_V5 = `${RUN_EVENT_TYPE},'CATALOG_READ','PLAN_CREATED','PURCHASE_SKIPPED','PAYMENT_FAILED','DATA_REJECTED','ANALYSIS_COMPLETED'`;

/** Migration 9 (approvals, D-066): the owner's approval request and decision. */
const RUN_EVENT_TYPE_V9 = `${RUN_EVENT_TYPE_V5},'PAYMENT_APPROVAL_REQUESTED','PAYMENT_APPROVAL_DECIDED'`;

/** Allowed (from, to) run transitions; must equal RUN_TRANSITIONS in the domain. */
export const SQL_RUN_TRANSITIONS: readonly (readonly [string, string])[] = [
  ['QUEUED', 'RUNNING'],
  ['QUEUED', 'CANCELLED'],
  ['RUNNING', 'SUCCEEDED'],
  ['RUNNING', 'FAILED'],
  ['RUNNING', 'CANCELLED'],
];

const runPairs = SQL_RUN_TRANSITIONS.map(
  ([f, t]) => `(OLD.status = '${f}' AND NEW.status = '${t}')`,
).join('\n          OR ');

/** Allowed (from, to) payment transitions; must equal PAYMENT_TRANSITIONS in the domain. */
export const SQL_PAYMENT_TRANSITIONS: readonly (readonly [string, string])[] = [
  ['CREATED', 'AUTHORIZED'],
  ['CREATED', 'REFUSED'],
  ['AUTHORIZED', 'SIGNED'],
  ['AUTHORIZED', 'FAILED'],
  ['SIGNED', 'SUBMITTED'],
  ['SIGNED', 'FAILED'],
  ['SUBMITTED', 'SETTLED'],
  ['SUBMITTED', 'UNKNOWN'],
  ['SUBMITTED', 'FAILED'],
  ['UNKNOWN', 'SETTLED'],
  ['UNKNOWN', 'FAILED'],
];

/** Outcomes of one Mirror Node verification; must equal VERIFICATION_OUTCOMES in the payment store. */
export const VERIFICATION_OUTCOME = `'SETTLED','MISMATCH','FAILED','PENDING','UNVERIFIABLE'`;

const INFERENCE_STATUS = `'PENDING','SUCCEEDED','FAILED','UNKNOWN','REFUSED'`;

/** Allowed (from, to) inference transitions; must equal INFERENCE_TRANSITIONS in the domain. */
export const SQL_INFERENCE_TRANSITIONS: readonly (readonly [string, string])[] = [
  ['PENDING', 'SUCCEEDED'],
  ['PENDING', 'FAILED'],
  ['PENDING', 'UNKNOWN'],
  ['UNKNOWN', 'SUCCEEDED'],
  ['UNKNOWN', 'FAILED'],
];

const inferencePairs = SQL_INFERENCE_TRANSITIONS.map(
  ([f, t]) => `(OLD.status = '${f}' AND NEW.status = '${t}')`,
).join('\n          OR ');

const allowedPairs = SQL_PAYMENT_TRANSITIONS.map(
  ([f, t]) => `(OLD.status = '${f}' AND NEW.status = '${t}')`,
).join('\n          OR ');

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'initial schema: providers, runs, events, payments, inference, reports',
    sql: `
CREATE TABLE providers (
  ens_name      TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  chain         TEXT NOT NULL CHECK (chain IN ('sepolia','mainnet')),
  resolver      TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  capabilities  TEXT NOT NULL,
  pay_to        TEXT NOT NULL,
  network       TEXT NOT NULL CHECK (network IN (${HEDERA_NETWORK})),
  asset         TEXT NOT NULL,
  price_atomic  TEXT NOT NULL,
  discovered_at TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  trigger     TEXT NOT NULL CHECK (trigger IN ('manual','scheduled')),
  watchlist   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN (${RUN_STATUS})),
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT,
  error       TEXT
) STRICT;
CREATE INDEX runs_created_at ON runs (created_at);

CREATE TABLE run_events (
  run_id  TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL CHECK (seq >= 0),
  type    TEXT NOT NULL CHECK (type IN (${RUN_EVENT_TYPE})),
  payload TEXT NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;

CREATE TABLE payment_intents (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES runs (id),
  provider       TEXT NOT NULL,
  pay_to         TEXT NOT NULL,
  network        TEXT NOT NULL CHECK (network IN (${HEDERA_NETWORK})),
  asset          TEXT NOT NULL,
  amount_atomic  TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN (${PAYMENT_STATUS})),
  refusal_code   TEXT,
  transaction_id TEXT UNIQUE,
  facilitator    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (status <> 'REFUSED' OR refusal_code IS NOT NULL),
  CHECK (status NOT IN ('SIGNED','SUBMITTED','SETTLED','UNKNOWN') OR transaction_id IS NOT NULL)
) STRICT;
CREATE INDEX payment_intents_run ON payment_intents (run_id);
CREATE INDEX payment_intents_status ON payment_intents (status);

CREATE TRIGGER payment_intents_insert_created
BEFORE INSERT ON payment_intents
WHEN NEW.status <> 'CREATED'
BEGIN
  SELECT RAISE(ABORT, 'payment intents must be created in status CREATED');
END;

CREATE TRIGGER payment_intents_status_transition
BEFORE UPDATE OF status ON payment_intents
WHEN NEW.status <> OLD.status AND NOT (
          ${allowedPairs}
     )
BEGIN
  SELECT RAISE(ABORT, 'illegal payment status transition');
END;

CREATE TRIGGER payment_intents_transaction_id_immutable
BEFORE UPDATE OF transaction_id ON payment_intents
WHEN OLD.transaction_id IS NOT NULL AND (NEW.transaction_id IS NULL OR NEW.transaction_id <> OLD.transaction_id)
BEGIN
  SELECT RAISE(ABORT, 'a recorded transaction ID cannot change');
END;

CREATE TABLE inference_calls (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT REFERENCES runs (id),
  purpose             TEXT NOT NULL CHECK (purpose IN ('PLAN','SELECT','ANALYZE','REPORT','PROBE')),
  network             TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
  model               TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','REFUSED')),
  request_id          TEXT UNIQUE,
  provider            TEXT,
  prompt_tokens       INTEGER CHECK (prompt_tokens >= 0),
  completion_tokens   INTEGER CHECK (completion_tokens >= 0),
  cost_neuron         TEXT,
  credit_used_neuron  TEXT,
  deposit_used_neuron TEXT,
  funding             TEXT NOT NULL CHECK (funding IN ('credits','deposit','mixed','none','unknown')),
  tee_verified        INTEGER CHECK (tee_verified IN (0, 1)),
  error_code          TEXT,
  created_at          TEXT NOT NULL,
  CHECK (funding <> 'credits' OR (credit_used_neuron IS NOT NULL AND credit_used_neuron <> '0'))
) STRICT;
CREATE INDEX inference_calls_created_at ON inference_calls (created_at);

CREATE TABLE reports (
  run_id     TEXT PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
  markdown   TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
`,
  },
  {
    id: 2,
    name: 'inference ledger: PENDING/UNKNOWN reservations, worst case, settlement, balance snapshots',
    // SQLite cannot change a CHECK in place, so inference_calls is rebuilt
    // (nothing references it) and its rows copied; columns added are NULL.
    sql: `
CREATE TABLE inference_calls_v2 (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT REFERENCES runs (id),
  purpose             TEXT NOT NULL CHECK (purpose IN ('PLAN','SELECT','ANALYZE','REPORT','PROBE')),
  network             TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
  model               TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (${INFERENCE_STATUS})),
  request_id          TEXT UNIQUE,
  provider            TEXT,
  prompt_tokens       INTEGER CHECK (prompt_tokens >= 0),
  completion_tokens   INTEGER CHECK (completion_tokens >= 0),
  worst_case_neuron   TEXT,
  cost_neuron         TEXT,
  credit_used_neuron  TEXT,
  deposit_used_neuron TEXT,
  funding             TEXT NOT NULL CHECK (funding IN ('credits','deposit','mixed','none','unknown')),
  tee_verified        INTEGER CHECK (tee_verified IN (0, 1)),
  error_code          TEXT,
  created_at          TEXT NOT NULL,
  settled_at          TEXT,
  reconciled_at       TEXT,
  CHECK (funding <> 'credits' OR (credit_used_neuron IS NOT NULL AND credit_used_neuron <> '0')),
  CHECK (status NOT IN ('PENDING','UNKNOWN') OR worst_case_neuron IS NOT NULL),
  CHECK (status <> 'SUCCEEDED' OR (request_id IS NOT NULL AND cost_neuron IS NOT NULL))
) STRICT;

INSERT INTO inference_calls_v2 (id, run_id, purpose, network, model, status, request_id, provider,
  prompt_tokens, completion_tokens, cost_neuron, credit_used_neuron, deposit_used_neuron, funding,
  tee_verified, error_code, created_at, settled_at)
SELECT id, run_id, purpose, network, model, status, request_id, provider,
  prompt_tokens, completion_tokens, cost_neuron, credit_used_neuron, deposit_used_neuron, funding,
  tee_verified, error_code, created_at, created_at
FROM inference_calls;

DROP TABLE inference_calls;
ALTER TABLE inference_calls_v2 RENAME TO inference_calls;
CREATE INDEX inference_calls_created_at ON inference_calls (created_at);
CREATE INDEX inference_calls_status ON inference_calls (status);

CREATE TRIGGER inference_calls_insert_state
BEFORE INSERT ON inference_calls
WHEN NEW.status NOT IN ('PENDING','REFUSED')
BEGIN
  SELECT RAISE(ABORT, 'inference calls must be created PENDING (reserved) or REFUSED');
END;

CREATE TRIGGER inference_calls_status_transition
BEFORE UPDATE OF status ON inference_calls
WHEN NEW.status <> OLD.status AND NOT (
          ${inferencePairs}
     )
BEGIN
  SELECT RAISE(ABORT, 'illegal inference status transition');
END;

CREATE TRIGGER inference_calls_billing_immutable
BEFORE UPDATE OF cost_neuron, request_id, worst_case_neuron ON inference_calls
WHEN (OLD.cost_neuron IS NOT NULL AND (NEW.cost_neuron IS NULL OR NEW.cost_neuron <> OLD.cost_neuron))
  OR (OLD.request_id IS NOT NULL AND (NEW.request_id IS NULL OR NEW.request_id <> OLD.request_id))
  OR (OLD.worst_case_neuron IS NOT NULL AND (NEW.worst_case_neuron IS NULL OR NEW.worst_case_neuron <> OLD.worst_case_neuron))
BEGIN
  SELECT RAISE(ABORT, 'a recorded cost, request ID or reservation cannot change');
END;

CREATE TABLE zg_balance_snapshots (
  id                     TEXT PRIMARY KEY,
  network                TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
  address                TEXT NOT NULL,
  deposit_balance_neuron TEXT,
  credit_balance_neuron  TEXT,
  pending_charge_neuron  TEXT,
  total_balance_neuron   TEXT,
  balance_neuron         TEXT,
  trigger                TEXT NOT NULL CHECK (trigger IN ('job','manual')),
  taken_at               TEXT NOT NULL
) STRICT;
CREATE INDEX zg_balance_snapshots_taken_at ON zg_balance_snapshots (taken_at);
`,
  },
  {
    id: 3,
    name: 'payment state machine: idempotency key, purchase identity, failure and reconciliation fields, transition log',
    sql: `
ALTER TABLE payment_intents ADD COLUMN idempotency_key TEXT;
ALTER TABLE payment_intents ADD COLUMN capability TEXT;
ALTER TABLE payment_intents ADD COLUMN request_url TEXT;
ALTER TABLE payment_intents ADD COLUMN error_code TEXT;
ALTER TABLE payment_intents ADD COLUMN settled_at TEXT;
ALTER TABLE payment_intents ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_attempts >= 0);
ALTER TABLE payment_intents ADD COLUMN last_checked_at TEXT;
CREATE UNIQUE INDEX payment_intents_idempotency_key ON payment_intents (idempotency_key);

CREATE TRIGGER payment_intents_insert_identity
BEFORE INSERT ON payment_intents
WHEN NEW.idempotency_key IS NULL OR NEW.capability IS NULL OR NEW.request_url IS NULL
BEGIN
  SELECT RAISE(ABORT, 'payment intents need an idempotency key, capability and request URL');
END;

CREATE TRIGGER payment_intents_identity_immutable
BEFORE UPDATE OF idempotency_key, capability, request_url, amount_atomic, pay_to, provider, run_id ON payment_intents
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.capability IS NOT OLD.capability
  OR NEW.request_url IS NOT OLD.request_url OR NEW.amount_atomic IS NOT OLD.amount_atomic
  OR NEW.pay_to IS NOT OLD.pay_to OR NEW.provider IS NOT OLD.provider OR NEW.run_id IS NOT OLD.run_id
BEGIN
  SELECT RAISE(ABORT, 'what a payment buys, from whom and for how much cannot change');
END;

CREATE TRIGGER payment_intents_settled_at
BEFORE UPDATE OF status ON payment_intents
WHEN NEW.status = 'SETTLED' AND NEW.settled_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a SETTLED payment needs settled_at');
END;

CREATE TABLE payment_transitions (
  payment_id  TEXT NOT NULL REFERENCES payment_intents (id),
  seq         INTEGER NOT NULL CHECK (seq >= 0),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  detail      TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (payment_id, seq)
) STRICT;
`,
  },
  {
    id: 4,
    name: 'settlement verifier: append-only Mirror Node verifications; SETTLED requires one',
    sql: `
CREATE TABLE settlement_verifications (
  id                  TEXT PRIMARY KEY,
  payment_id          TEXT NOT NULL REFERENCES payment_intents (id),
  transaction_id      TEXT NOT NULL,
  mirror_node         TEXT NOT NULL,
  outcome             TEXT NOT NULL CHECK (outcome IN (${VERIFICATION_OUTCOME})),
  code                TEXT,
  consensus_timestamp TEXT,
  checks              TEXT NOT NULL,
  entries             INTEGER NOT NULL CHECK (entries >= 0),
  verified_at         TEXT NOT NULL,
  CHECK (outcome <> 'SETTLED' OR consensus_timestamp IS NOT NULL)
) STRICT;
CREATE INDEX settlement_verifications_payment ON settlement_verifications (payment_id);

CREATE TRIGGER payment_intents_settled_needs_verification
BEFORE UPDATE OF status ON payment_intents
WHEN NEW.status = 'SETTLED' AND NOT EXISTS (
  SELECT 1 FROM settlement_verifications v
  WHERE v.payment_id = NEW.id AND v.outcome = 'SETTLED' AND v.transaction_id = NEW.transaction_id
)
BEGIN
  SELECT RAISE(ABORT, 'a payment is SETTLED only after a Mirror Node verification says so');
END;

CREATE TRIGGER settlement_verifications_no_update
BEFORE UPDATE ON settlement_verifications
BEGIN
  SELECT RAISE(ABORT, 'settlement verifications are append-only');
END;

CREATE TRIGGER settlement_verifications_no_delete
BEFORE DELETE ON settlement_verifications
BEGIN
  SELECT RAISE(ABORT, 'settlement verifications are append-only');
END;
`,
  },
  {
    id: 5,
    name: 'orchestrator: pipeline event types; run events append-only and gapless; run transitions',
    // run_events is rebuilt for the wider type CHECK (nothing references it); rows are copied.
    sql: `
CREATE TABLE run_events_v5 (
  run_id  TEXT NOT NULL REFERENCES runs (id),
  seq     INTEGER NOT NULL CHECK (seq >= 0),
  type    TEXT NOT NULL CHECK (type IN (${RUN_EVENT_TYPE_V5})),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  at      TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;
INSERT INTO run_events_v5 (run_id, seq, type, payload, at)
SELECT run_id, seq, type, payload, at FROM run_events;
DROP TABLE run_events;
ALTER TABLE run_events_v5 RENAME TO run_events;

CREATE TRIGGER run_events_gapless
BEFORE INSERT ON run_events
WHEN NEW.seq <> (SELECT COALESCE(MAX(seq) + 1, 0) FROM run_events WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'run events are appended in order, without gaps');
END;

CREATE TRIGGER run_events_open_run
BEFORE INSERT ON run_events
WHEN (SELECT status FROM runs WHERE id = NEW.run_id) IN ('SUCCEEDED','FAILED','CANCELLED')
BEGIN
  SELECT RAISE(ABORT, 'a finished run takes no more events');
END;

CREATE TRIGGER run_events_no_update
BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;

CREATE TRIGGER run_events_no_delete
BEFORE DELETE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;

CREATE TRIGGER runs_status_transition
BEFORE UPDATE OF status ON runs
WHEN NEW.status <> OLD.status AND NOT (
          ${runPairs}
     )
BEGIN
  SELECT RAISE(ABORT, 'illegal run status transition');
END;

CREATE TRIGGER runs_identity_immutable
BEFORE UPDATE OF id, trigger, watchlist, created_at ON runs
WHEN NEW.id IS NOT OLD.id OR NEW.trigger IS NOT OLD.trigger
  OR NEW.watchlist IS NOT OLD.watchlist OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'what a run was asked to do cannot change');
END;
`,
  },
  {
    id: 6,
    name: 'owner spending policy: append-only versions under the env ceilings; kill switch',
    // The latest version is the policy in force; earlier versions are the audit trail (D-052).
    sql: `
CREATE TABLE policy_versions (
  version              INTEGER PRIMARY KEY CHECK (version >= 1),
  max_per_payment      TEXT NOT NULL CHECK (max_per_payment GLOB '[1-9]*' AND max_per_payment NOT GLOB '*[^0-9]*' AND length(max_per_payment) <= 30),
  max_per_run          TEXT NOT NULL CHECK (max_per_run GLOB '[1-9]*' AND max_per_run NOT GLOB '*[^0-9]*' AND length(max_per_run) <= 30),
  max_per_day          TEXT NOT NULL CHECK (max_per_day GLOB '[1-9]*' AND max_per_day NOT GLOB '*[^0-9]*' AND length(max_per_day) <= 30),
  max_payments_per_run INTEGER NOT NULL CHECK (max_payments_per_run >= 1),
  payments_paused      INTEGER NOT NULL CHECK (payments_paused IN (0, 1)),
  reason               TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  changed_by           TEXT NOT NULL CHECK (changed_by IN ('owner')),
  created_at           TEXT NOT NULL
) STRICT;

CREATE TRIGGER policy_versions_in_order
BEFORE INSERT ON policy_versions
WHEN NEW.version <> (SELECT COALESCE(MAX(version) + 1, 1) FROM policy_versions)
BEGIN
  SELECT RAISE(ABORT, 'policy versions are appended in order, without gaps');
END;

CREATE TRIGGER policy_versions_no_update
BEFORE UPDATE ON policy_versions
BEGIN
  SELECT RAISE(ABORT, 'policy versions are append-only');
END;

CREATE TRIGGER policy_versions_no_delete
BEFORE DELETE ON policy_versions
BEGIN
  SELECT RAISE(ABORT, 'policy versions are append-only');
END;
`,
  },
  {
    id: 7,
    name: 'recurring watchlist brief: schedules and one claimed run per schedule per UTC day',
    // schedule_runs is the claim: its primary key makes a second run on the same UTC day impossible (D-056).
    sql: `
CREATE TABLE schedules (
  id                TEXT PRIMARY KEY,
  watchlist         TEXT NOT NULL CHECK (json_valid(watchlist) AND json_type(watchlist) = 'array'),
  budget            TEXT NOT NULL CHECK (budget GLOB '[1-9]*' AND budget NOT GLOB '*[^0-9]*' AND length(budget) <= 30),
  run_after_minute  INTEGER NOT NULL CHECK (run_after_minute BETWEEN 0 AND 1439),
  enabled           INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  last_skip         TEXT CHECK (last_skip IS NULL OR length(last_skip) <= 300),
  last_skip_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

CREATE TABLE schedule_runs (
  schedule_id  TEXT NOT NULL REFERENCES schedules (id),
  day          TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  run_id       TEXT NOT NULL UNIQUE REFERENCES runs (id),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (schedule_id, day)
) STRICT;

CREATE TRIGGER schedule_runs_no_update
BEFORE UPDATE ON schedule_runs
BEGIN
  SELECT RAISE(ABORT, 'schedule runs are append-only');
END;

CREATE TRIGGER schedule_runs_no_delete
BEFORE DELETE ON schedule_runs
BEGIN
  SELECT RAISE(ABORT, 'schedule runs are append-only');
END;
`,
  },
  {
    id: 8,
    name: 'HCS audit messages: one live message per settlement and per task; transaction ID before submit',
    // Like payments (D-042): the transaction ID is stored before the submit and never changes; an
    // ambiguous submit is UNKNOWN until the Mirror Node decides; only a definite failure frees the slot (D-057).
    sql: `
CREATE TABLE hcs_messages (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs (id),
  kind                TEXT NOT NULL CHECK (kind IN ('settlement','task')),
  payment_id          TEXT REFERENCES payment_intents (id),
  topic_id            TEXT NOT NULL CHECK (topic_id GLOB '0.0.[0-9]*'),
  payload             TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 1024),
  payload_sha256      TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  transaction_id      TEXT NOT NULL UNIQUE,
  status              TEXT NOT NULL CHECK (status IN ('SUBMITTING','SUBMITTED','CONFIRMED','UNKNOWN','FAILED')),
  sequence_number     TEXT CHECK (sequence_number IS NULL OR (sequence_number GLOB '[1-9]*' AND sequence_number NOT GLOB '*[^0-9]*')),
  consensus_timestamp TEXT,
  error               TEXT CHECK (error IS NULL OR length(error) <= 300),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (kind <> 'settlement' OR payment_id IS NOT NULL),
  CHECK (kind <> 'task' OR payment_id IS NULL),
  CHECK (status NOT IN ('SUBMITTED','CONFIRMED') OR sequence_number IS NOT NULL),
  CHECK (status <> 'CONFIRMED' OR consensus_timestamp IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX hcs_messages_one_live_settlement ON hcs_messages (payment_id)
  WHERE kind = 'settlement' AND status <> 'FAILED';
CREATE UNIQUE INDEX hcs_messages_one_live_task ON hcs_messages (run_id)
  WHERE kind = 'task' AND status <> 'FAILED';
CREATE INDEX hcs_messages_run ON hcs_messages (run_id);

CREATE TRIGGER hcs_messages_born_submitting
BEFORE INSERT ON hcs_messages
WHEN NEW.status <> 'SUBMITTING'
BEGIN
  SELECT RAISE(ABORT, 'an audit message is recorded before it is submitted');
END;

CREATE TRIGGER hcs_messages_identity_immutable
BEFORE UPDATE OF id, run_id, kind, payment_id, topic_id, payload, payload_sha256, transaction_id, created_at ON hcs_messages
WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.kind IS NOT OLD.kind
  OR NEW.payment_id IS NOT OLD.payment_id OR NEW.topic_id IS NOT OLD.topic_id
  OR NEW.payload IS NOT OLD.payload OR NEW.payload_sha256 IS NOT OLD.payload_sha256
  OR NEW.transaction_id IS NOT OLD.transaction_id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'what an audit message says, and its transaction ID, cannot change');
END;

CREATE TRIGGER hcs_messages_status_transition
BEFORE UPDATE OF status ON hcs_messages
WHEN NEW.status <> OLD.status AND NOT (
     (OLD.status = 'SUBMITTING' AND NEW.status IN ('SUBMITTED','UNKNOWN','FAILED'))
  OR (OLD.status = 'SUBMITTED' AND NEW.status IN ('CONFIRMED','UNKNOWN'))
  OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('CONFIRMED','FAILED'))
)
BEGIN
  SELECT RAISE(ABORT, 'illegal audit message status transition');
END;

CREATE TRIGGER hcs_messages_sequence_immutable
BEFORE UPDATE OF sequence_number, consensus_timestamp ON hcs_messages
WHEN (OLD.sequence_number IS NOT NULL AND NEW.sequence_number IS NOT OLD.sequence_number)
  OR (OLD.consensus_timestamp IS NOT NULL AND NEW.consensus_timestamp IS NOT OLD.consensus_timestamp)
BEGIN
  SELECT RAISE(ABORT, 'a recorded sequence number or consensus timestamp never changes');
END;

CREATE TRIGGER hcs_messages_no_delete
BEFORE DELETE ON hcs_messages
BEGIN
  SELECT RAISE(ABORT, 'audit messages are never deleted');
END;
`,
  },
  {
    id: 9,
    name: 'spending controls: approval mode and per-provider caps on owner policies; payment approvals; approval events',
    // policy_versions gains columns (ADD COLUMN is not an UPDATE, so its append-only triggers stay).
    // run_events is rebuilt for the wider type CHECK, exactly as in migration 5 (nothing references it).
    // An approval is decided once: PENDING becomes APPROVED, REJECTED or EXPIRED, never again (D-066).
    sql: `
ALTER TABLE policy_versions ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'autonomous' CHECK (approval_mode IN ('autonomous','human'));
ALTER TABLE policy_versions ADD COLUMN approval_above TEXT NOT NULL DEFAULT '0' CHECK (approval_above GLOB '[0-9]*' AND approval_above NOT GLOB '*[^0-9]*' AND length(approval_above) <= 30);
ALTER TABLE policy_versions ADD COLUMN provider_caps TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provider_caps) AND json_type(provider_caps) = 'object');

CREATE TABLE payment_approvals (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs (id),
  payment_id    TEXT NOT NULL UNIQUE REFERENCES payment_intents (id),
  provider      TEXT NOT NULL,
  capability    TEXT NOT NULL,
  pay_to        TEXT NOT NULL CHECK (pay_to GLOB '0.0.[0-9]*'),
  amount_atomic TEXT NOT NULL CHECK (amount_atomic GLOB '[1-9]*' AND amount_atomic NOT GLOB '*[^0-9]*' AND length(amount_atomic) <= 30),
  request_url   TEXT NOT NULL CHECK (length(request_url) <= 2048),
  threshold     TEXT NOT NULL CHECK (threshold GLOB '[0-9]*' AND threshold NOT GLOB '*[^0-9]*' AND length(threshold) <= 30),
  status        TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  requested_at  TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  decided_at    TEXT,
  decided_by    TEXT CHECK (decided_by IS NULL OR decided_by IN ('owner','timeout','restart')),
  note          TEXT CHECK (note IS NULL OR length(note) <= 200),
  CHECK (status = 'PENDING' OR (decided_at IS NOT NULL AND decided_by IS NOT NULL))
) STRICT;
CREATE INDEX payment_approvals_status ON payment_approvals (status);

CREATE TRIGGER payment_approvals_born_pending
BEFORE INSERT ON payment_approvals
WHEN NEW.status <> 'PENDING'
BEGIN
  SELECT RAISE(ABORT, 'an approval is requested before it is decided');
END;

CREATE TRIGGER payment_approvals_decided_once
BEFORE UPDATE ON payment_approvals
WHEN OLD.status <> 'PENDING' OR NEW.status NOT IN ('APPROVED','REJECTED','EXPIRED')
  OR NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.payment_id IS NOT OLD.payment_id
  OR NEW.provider IS NOT OLD.provider OR NEW.capability IS NOT OLD.capability
  OR NEW.pay_to IS NOT OLD.pay_to OR NEW.amount_atomic IS NOT OLD.amount_atomic
  OR NEW.request_url IS NOT OLD.request_url OR NEW.threshold IS NOT OLD.threshold
  OR NEW.requested_at IS NOT OLD.requested_at OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'an approval is decided once, and what it asked never changes');
END;

CREATE TRIGGER payment_approvals_no_delete
BEFORE DELETE ON payment_approvals
BEGIN
  SELECT RAISE(ABORT, 'approvals are never deleted');
END;

CREATE TABLE run_events_v9 (
  run_id  TEXT NOT NULL REFERENCES runs (id),
  seq     INTEGER NOT NULL CHECK (seq >= 0),
  type    TEXT NOT NULL CHECK (type IN (${RUN_EVENT_TYPE_V9})),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  at      TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;
INSERT INTO run_events_v9 (run_id, seq, type, payload, at)
SELECT run_id, seq, type, payload, at FROM run_events;
DROP TABLE run_events;
ALTER TABLE run_events_v9 RENAME TO run_events;

CREATE TRIGGER run_events_gapless
BEFORE INSERT ON run_events
WHEN NEW.seq <> (SELECT COALESCE(MAX(seq) + 1, 0) FROM run_events WHERE run_id = NEW.run_id)
BEGIN
  SELECT RAISE(ABORT, 'run events are appended in order, without gaps');
END;

CREATE TRIGGER run_events_open_run
BEFORE INSERT ON run_events
WHEN (SELECT status FROM runs WHERE id = NEW.run_id) IN ('SUCCEEDED','FAILED','CANCELLED')
BEGIN
  SELECT RAISE(ABORT, 'a finished run takes no more events');
END;

CREATE TRIGGER run_events_no_update
BEFORE UPDATE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;

CREATE TRIGGER run_events_no_delete
BEFORE DELETE ON run_events
BEGIN
  SELECT RAISE(ABORT, 'run events are append-only');
END;
`,
  },
  {
    id: 10,
    name: 'inference ledger: TRANSCRIBE purpose (voice task, D-076); a call joins a run once',
    // SQLite cannot change a CHECK in place: inference_calls is rebuilt exactly as in migration 2,
    // with TRANSCRIBE allowed, and its indexes and triggers recreated (nothing references it).
    // A voice transcription is recorded before its task exists and attached to the run once.
    sql: `
CREATE TABLE inference_calls_v10 (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT REFERENCES runs (id),
  purpose             TEXT NOT NULL CHECK (purpose IN ('PLAN','SELECT','ANALYZE','REPORT','PROBE','TRANSCRIBE')),
  network             TEXT NOT NULL CHECK (network IN ('mainnet','testnet')),
  model               TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (${INFERENCE_STATUS})),
  request_id          TEXT UNIQUE,
  provider            TEXT,
  prompt_tokens       INTEGER CHECK (prompt_tokens >= 0),
  completion_tokens   INTEGER CHECK (completion_tokens >= 0),
  worst_case_neuron   TEXT,
  cost_neuron         TEXT,
  credit_used_neuron  TEXT,
  deposit_used_neuron TEXT,
  funding             TEXT NOT NULL CHECK (funding IN ('credits','deposit','mixed','none','unknown')),
  tee_verified        INTEGER CHECK (tee_verified IN (0, 1)),
  error_code          TEXT,
  created_at          TEXT NOT NULL,
  settled_at          TEXT,
  reconciled_at       TEXT,
  CHECK (funding <> 'credits' OR (credit_used_neuron IS NOT NULL AND credit_used_neuron <> '0')),
  CHECK (status NOT IN ('PENDING','UNKNOWN') OR worst_case_neuron IS NOT NULL),
  CHECK (status <> 'SUCCEEDED' OR (request_id IS NOT NULL AND cost_neuron IS NOT NULL))
) STRICT;

INSERT INTO inference_calls_v10 SELECT id, run_id, purpose, network, model, status, request_id,
  provider, prompt_tokens, completion_tokens, worst_case_neuron, cost_neuron, credit_used_neuron,
  deposit_used_neuron, funding, tee_verified, error_code, created_at, settled_at, reconciled_at
FROM inference_calls;

DROP TABLE inference_calls;
ALTER TABLE inference_calls_v10 RENAME TO inference_calls;
CREATE INDEX inference_calls_created_at ON inference_calls (created_at);
CREATE INDEX inference_calls_status ON inference_calls (status);

CREATE TRIGGER inference_calls_insert_state
BEFORE INSERT ON inference_calls
WHEN NEW.status NOT IN ('PENDING','REFUSED')
BEGIN
  SELECT RAISE(ABORT, 'inference calls must be created PENDING (reserved) or REFUSED');
END;

CREATE TRIGGER inference_calls_status_transition
BEFORE UPDATE OF status ON inference_calls
WHEN NEW.status <> OLD.status AND NOT (
          ${inferencePairs}
     )
BEGIN
  SELECT RAISE(ABORT, 'illegal inference status transition');
END;

CREATE TRIGGER inference_calls_billing_immutable
BEFORE UPDATE OF cost_neuron, request_id, worst_case_neuron ON inference_calls
WHEN (OLD.cost_neuron IS NOT NULL AND (NEW.cost_neuron IS NULL OR NEW.cost_neuron <> OLD.cost_neuron))
  OR (OLD.request_id IS NOT NULL AND (NEW.request_id IS NULL OR NEW.request_id <> OLD.request_id))
  OR (OLD.worst_case_neuron IS NOT NULL AND (NEW.worst_case_neuron IS NULL OR NEW.worst_case_neuron <> OLD.worst_case_neuron))
BEGIN
  SELECT RAISE(ABORT, 'a recorded cost, request ID or reservation cannot change');
END;

CREATE TRIGGER inference_calls_run_once
BEFORE UPDATE OF run_id ON inference_calls
WHEN NEW.run_id IS NOT OLD.run_id AND (OLD.run_id IS NOT NULL OR OLD.purpose <> 'TRANSCRIBE')
BEGIN
  SELECT RAISE(ABORT, 'only a voice transcription joins a run, and only once');
END;
`,
  },
];
