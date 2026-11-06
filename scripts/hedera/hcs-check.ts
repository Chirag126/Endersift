/**
 * LIVE check of the HCS audit (plan row 29, D-057): read a run's audit
 * messages back from the Mirror Node and compare them with the agent's
 * records. Reads only (database + Mirror Node); spends nothing.
 *
 *   pnpm hcs:check                       the latest run with audit messages
 *   pnpm hcs:check -- --run <id> --save-evidence
 *
 * Verified when, for that run (which must have settled at least one payment):
 *   - every settled payment has a CONFIRMED settlement message and the run a
 *     CONFIRMED task digest, all on the configured topic;
 *   - each message read from the Mirror Node is byte for byte the recorded
 *     payload (SHA-256 equal), at the recorded sequence number;
 *   - each settlement message names that payment's transaction ID, payee and
 *     amount; the digest lists the settled transaction IDs and the brief's
 *     SHA-256;
 *   - the payer posted them (the topic's submit key).
 */
import { auditMessagesOf } from '../../apps/server/src/audit/auditor.ts';
import { sha256Hex } from '../../apps/server/src/audit/payloads.ts';
import { loadServerConfig } from '../../apps/server/src/config.ts';
import { openDatabase } from '../../apps/server/src/db/database.ts';
import { getReport, getRun } from '../../apps/server/src/db/repositories.ts';
import { SqlitePaymentStore } from '../../apps/server/src/payments/payment-store.ts';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  MirrorNodeClient,
  hashscanTopicUrl,
  hashscanTransactionUrl,
} from '../../packages/hedera/src/index.ts';
import {
  UsageError,
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const source = loadLocalEnvSource();
const env = loadEnv(['core', 'hedera-network'], source);
const config = loadServerConfig(source);
const network = env.require('HEDERA_NETWORK') as 'testnet' | 'mainnet';
const topicId = source['HCS_TOPIC_ID'];
if (topicId === undefined || topicId === '')
  throw new UsageError('set HCS_TOPIC_ID in .env (pnpm hcs:create-topic)');
const payer = source['HEDERA_PAYER_ACCOUNT_ID'] ?? null;
const { db } = openDatabase(config.databasePath);
const store = new SqlitePaymentStore(db);
const mirror = new MirrorNodeClient(env.require('HEDERA_MIRROR_NODE_URL'));

type MaybeRun = { readonly run_id: string } | undefined;
const runId =
  argValue('--run') ??
  (
    db
      .prepare(
        "SELECT run_id FROM hcs_messages WHERE topic_id = ? AND kind = 'settlement' ORDER BY created_at DESC LIMIT 1",
      )
      .get(topicId) as MaybeRun
  )?.run_id;
if (runId === undefined)
  throw new UsageError(
    `no settlement messages on ${topicId} yet: run a task that pays at least one provider`,
  );
const run = getRun(db, runId);
if (run === null) throw new UsageError(`no run ${runId}`);

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}`);
};

console.log(`HCS audit check: run ${runId} (${run.status}) on topic ${topicId}\n`);
const messages = auditMessagesOf(db, runId).filter((m) => m.status !== 'FAILED');
const payments = (await store.listByRun(runId)).filter(
  (p) => p.status === 'SETTLED' && p.transactionId !== null,
);
const report = getReport(db, runId);

const rows: Record<string, unknown>[] = [];
for (const m of messages) {
  const onMirror =
    m.sequenceNumber === null ? null : await mirror.getTopicMessage(m.topicId, m.sequenceNumber);
  const bytesOk = onMirror !== null && sha256Hex(onMirror.message) === m.payloadSha256;
  const payload = JSON.parse(m.payload) as Record<string, unknown>;
  const label = `${m.kind}${m.kind === 'settlement' ? ` ${String(payload['provider'])}` : ''} #${m.sequenceNumber ?? '?'}`;
  check(
    `${label}: CONFIRMED on ${topicId}`,
    m.status === 'CONFIRMED' && m.topicId === topicId,
    m.status,
  );
  check(
    `${label}: Mirror Node bytes equal the record (SHA-256)`,
    bytesOk,
    m.payloadSha256.slice(0, 16),
  );
  check(
    `${label}: posted by the payer`,
    onMirror !== null && (payer === null || onMirror.payerAccountId === payer),
    String(onMirror?.payerAccountId),
  );
  if (m.kind === 'settlement') {
    const p = payments.find((x) => x.id === m.paymentId);
    check(
      `${label}: names the settled payment (tx, payee, amount)`,
      p !== undefined &&
        payload['tx'] === p.transactionId &&
        payload['payTo'] === p.payTo &&
        payload['amount'] === p.amountAtomic,
      String(payload['tx']),
    );
  } else {
    const settled = Array.isArray(payload['settled']) ? (payload['settled'] as string[]) : null;
    check(
      `${label}: digest lists the settled transactions and the brief's SHA-256`,
      (settled === null
        ? payload['settledCount'] === payments.length
        : payments.every((p) => settled.includes(p.transactionId as string))) &&
        payload['reportSha256'] === (report === null ? null : sha256Hex(report.markdown)),
    );
  }
  rows.push({
    kind: m.kind,
    status: m.status,
    sequenceNumber: m.sequenceNumber,
    consensusTimestamp: onMirror?.consensusTimestamp ?? m.consensusTimestamp,
    transactionId: m.transactionId,
    hashscan: hashscanTransactionUrl(network, m.transactionId),
    payloadSha256: m.payloadSha256,
    payload,
  });
}
check(
  'every settled payment has a settlement message',
  payments.every((p) => messages.some((m) => m.kind === 'settlement' && m.paymentId === p.id)),
  `${payments.length} settled`,
);
check(
  'the run has a task digest',
  messages.some((m) => m.kind === 'task'),
);
// "each settlement is posted" cannot be shown by a run that settled nothing (D-059)
check(
  'the run settled at least one payment, so settlement messages are shown too',
  payments.length > 0,
  `${payments.length} settled; choose a run with --run <id>`,
);

const verified = checks.length > 0 && checks.every((c) => c.ok);
console.log(
  verified
    ? '\nVERIFIED: the audit messages are on the Mirror Node as recorded.'
    : '\nNOT VERIFIED: see the FAIL lines above.',
);
if (hasFlag('--save-evidence')) {
  const path = writeEvidence('hcs', verified ? 'hcs-audit' : 'hcs-audit-attempt', {
    kind: 'hcs-audit-live',
    verified,
    generatedAt: new Date().toISOString(),
    network,
    topicId,
    topic: hashscanTopicUrl(network, topicId),
    run: { id: runId, status: run.status, trigger: run.trigger },
    settledPayments: payments.map((p) => ({
      provider: p.provider,
      amountAtomic: p.amountAtomic,
      transactionId: p.transactionId,
    })),
    checks,
    messages: rows,
  });
  console.log(`\nEvidence written to ${path}`);
}
db.close();
if (!verified) process.exitCode = 1;
