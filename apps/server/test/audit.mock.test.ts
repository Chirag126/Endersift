// Class: mock (the HCS auditor through the MOCK orchestrator harness: a fake
// topic and Mirror Node) and unit (payloads, database guards). NOT live
// verification: that is `pnpm hcs:check` against the real Mirror Node (D-057).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { Auditor, auditMessagesOf } from '../src/audit/auditor.ts';
import {
  AUDIT_MESSAGE_MAX_BYTES,
  encodeMessage,
  sha256Hex,
  taskMessage,
} from '../src/audit/payloads.ts';
import { getReport } from '../src/db/repositories.ts';
import {
  BUY_KEV,
  BUY_OSV,
  analysisJson,
  harness,
  planJson,
} from './support/orchestrator-harness.ts';

const WATCHLIST = ['OpenSSL', 'lodash@4.17.21 (npm)'];
const twoPayments = () =>
  harness({
    plan: () => planJson([BUY_KEV, BUY_OSV]),
    analysis: () => analysisJson(['CVE-2026-1001', 'GHSA-aaaa-bbbb-cccc']),
  });

describe('HCS audit (mock)', () => {
  it('posts one message per settlement and a task digest, each confirmed byte for byte', async () => {
    const h = twoPayments();
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'SUCCEEDED');
    const msgs = auditMessagesOf(h.db, run.id);
    assert.deepEqual(
      msgs.map((m) => [m.kind, m.status]),
      [
        ['settlement', 'CONFIRMED'],
        ['settlement', 'CONFIRMED'],
        ['task', 'CONFIRMED'],
      ],
    );
    assert.equal(h.topic.length, 3);
    for (const m of msgs) {
      const posted = h.topic.find((t) => t.seq === m.sequenceNumber);
      assert.equal(sha256Hex(posted?.bytes ?? new Uint8Array()), m.payloadSha256);
      assert.ok(m.consensusTimestamp !== null);
      // public and permanent: no watchlist, no URLs
      assert.ok(!/openssl|lodash|https?:/i.test(m.payload), m.payload);
    }
    const payments = (await h.store.listByRun(run.id)).filter((p) => p.status === 'SETTLED');
    const settlement = JSON.parse(msgs[0]?.payload ?? '{}') as Record<string, unknown>;
    assert.equal(settlement['tx'], payments[0]?.transactionId);
    assert.equal(settlement['payTo'], payments[0]?.payTo);
    const task = JSON.parse(msgs[2]?.payload ?? '{}') as Record<string, unknown>;
    assert.deepEqual(
      [...((task['settled'] as string[]) ?? [])].sort(),
      payments.map((p) => p.transactionId).sort(),
    );
    assert.equal(task['reportSha256'], sha256Hex(getReport(h.db, run.id)?.markdown ?? ''));
    assert.equal(task['verdict'], 'mock');
    // auditing again posts nothing new
    const again = await h.auditor?.auditRun(run.id);
    assert.equal(again?.posted, 0);
    assert.equal(h.topic.length, 3);
  });

  it('an ambiguous submit is UNKNOWN, never resent, and the Mirror Node decides it', async () => {
    const h = harness({
      plan: () => planJson([BUY_KEV]),
      analysis: () => analysisJson(['CVE-2026-1001']),
      audit: 'ambiguous',
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'SUCCEEDED', 'an audit problem never changes the run');
    assert.deepEqual(
      auditMessagesOf(h.db, run.id).map((m) => m.status),
      ['UNKNOWN', 'UNKNOWN'],
    );
    await h.auditor?.auditRun(run.id); // must not resend while UNKNOWN
    assert.equal(h.topic.length, 2);
    await h.auditor?.reconcile();
    const after = auditMessagesOf(h.db, run.id);
    assert.deepEqual(
      after.map((m) => m.status),
      ['CONFIRMED', 'CONFIRMED'],
    );
    assert.ok(after.every((m) => m.sequenceNumber !== null));
    assert.equal(h.topic.length, 2);
  });

  it('a definite refusal is FAILED and frees the slot for a new message; the run is unchanged', async () => {
    const h = harness({
      plan: () => planJson([BUY_KEV]),
      analysis: () => analysisJson(['CVE-2026-1001']),
      audit: 'refused',
    });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    assert.equal(run.status, 'SUCCEEDED');
    assert.deepEqual(
      auditMessagesOf(h.db, run.id).map((m) => m.status),
      ['FAILED', 'FAILED'],
    );
    assert.match(auditMessagesOf(h.db, run.id)[0]?.error ?? '', /^INVALID_SIGNATURE/);
    await h.auditor?.auditRun(run.id);
    assert.equal(auditMessagesOf(h.db, run.id).length, 4, 'tried again: a FAILED slot is free');
  });

  it('an UNKNOWN message whose transaction never reached consensus becomes FAILED after it expires', async () => {
    const h = harness({ plan: () => planJson([]), audit: 'off' });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    let clock = Date.parse('2026-10-28T10:00:00.000Z');
    const auditor = new Auditor({
      db: h.db,
      agent: 'chirag126.eth',
      mode: 'mock',
      payments: h.store,
      inference: h.ledger,
      now: () => new Date(clock),
      sleep: async () => {},
      confirmAttempts: 1,
      publisher: {
        topicId: '0.0.9999902',
        newTransactionId: () => `0.0.11044318@${Math.floor(clock / 1000)}.000000000`,
        submit: async () => {
          throw new Error('timeout (fake)');
        },
      },
      mirror: {
        getTopicMessage: async () => null,
        getTopicMessageAt: async () => null,
        getTransactions: async () => [],
      },
    });
    await auditor.auditRun(run.id);
    assert.equal(auditMessagesOf(h.db, run.id)[0]?.status, 'UNKNOWN');
    await auditor.reconcile();
    assert.equal(auditMessagesOf(h.db, run.id)[0]?.status, 'UNKNOWN', 'not yet expired');
    clock += 5 * 60_000;
    await auditor.reconcile();
    const m = auditMessagesOf(h.db, run.id)[0];
    assert.equal(m?.status, 'FAILED');
    assert.match(m?.error ?? '', /^TX_EXPIRED_NOT_FOUND/);
  });

  it('a Mirror Node message that differs from the record is never CONFIRMED', async () => {
    const h = harness({ plan: () => planJson([]), audit: 'off' });
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    const auditor = new Auditor({
      db: h.db,
      agent: 'chirag126.eth',
      mode: 'mock',
      payments: h.store,
      inference: h.ledger,
      sleep: async () => {},
      confirmAttempts: 1,
      publisher: {
        topicId: '0.0.9999902',
        newTransactionId: () => '0.0.11044318@1793200001.000000000',
        submit: async () => ({ sequenceNumber: '7' }),
      },
      mirror: {
        getTopicMessage: async (topicId, seq) => ({
          topicId,
          sequenceNumber: seq,
          consensusTimestamp: '1793200100.000000001',
          message: new TextEncoder().encode('{"type":"task","forged":true}'),
          runningHash: 'aa',
          payerAccountId: '0.0.11044318',
        }),
        getTopicMessageAt: async () => null,
        getTransactions: async () => [],
      },
    });
    await auditor.auditRun(run.id);
    const m = auditMessagesOf(h.db, run.id)[0];
    assert.equal(m?.status, 'UNKNOWN');
    assert.match(m?.error ?? '', /^MIRROR_MISMATCH/);
  });

  it('the database keeps one live message per settlement, born SUBMITTING, never edited or deleted', async () => {
    const h = twoPayments();
    const { run } = await h.orchestrator.run({ trigger: 'manual', watchlist: WATCHLIST });
    const [m] = auditMessagesOf(h.db, run.id);
    assert.ok(m !== undefined);
    const insert = (status: string, tx: string) =>
      h.db
        .prepare(
          `INSERT INTO hcs_messages (id, run_id, kind, payment_id, topic_id, payload, payload_sha256, transaction_id, status, created_at, updated_at)
           VALUES (?, ?, 'settlement', ?, '0.0.9999902', '{}', ?, ?, ?, 'x', 'x')`,
        )
        .run(randomUUID(), run.id, m.paymentId, 'a'.repeat(64), tx, status);
    assert.throws(() => insert('SUBMITTED', '0.0.1@1.1'), /recorded before it is submitted/);
    assert.throws(() => insert('SUBMITTING', '0.0.1@1.2'), /UNIQUE/);
    assert.throws(
      () => h.db.prepare('UPDATE hcs_messages SET payload = \'{"x":1}\' WHERE id = ?').run(m.id),
      /cannot change/,
    );
    assert.throws(
      () => h.db.prepare("UPDATE hcs_messages SET status = 'SUBMITTING' WHERE id = ?").run(m.id),
      /illegal audit message status transition/,
    );
    assert.throws(() => h.db.prepare('DELETE FROM hcs_messages').run(), /never deleted/);
  });
});

describe('audit payloads (unit)', () => {
  it('a digest that would exceed one HCS chunk keeps counts instead of IDs', () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `0.0.7162784@1793113618.${String(i).padStart(9, '0')}`,
    );
    const msg = taskMessage({
      agent: 'chirag126.eth',
      runId: '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a',
      trigger: 'scheduled',
      status: 'SUCCEEDED',
      verdict: 'e2e-verified',
      finishedAt: '2026-10-28T00:20:00.000Z',
      ensBlock: '12010000',
      policyVersion: 3,
      reportSha256: 'b'.repeat(64),
      settled: many,
      refused: 0,
      inference: [],
    });
    const encoded = encodeMessage(msg);
    assert.ok(encoded.bytes.length <= AUDIT_MESSAGE_MAX_BYTES);
    assert.equal(msg['settledCount'], 40);
    assert.equal(msg['settled'], undefined);
    assert.throws(() => encodeMessage({ big: 'x'.repeat(1100) }), RangeError);
  });
});
