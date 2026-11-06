/**
 * Reconcile payments whose outcome is unknown against the Hedera Mirror Node
 * (plan row 20). Nothing is ever signed or re-sent.
 *
 *   pnpm payments:reconcile                 SUBMITTED / UNKNOWN intents in DATABASE_PATH
 *   pnpm payments:reconcile -- --proof --save-evidence
 *        proof on the REAL Mirror Node with an in-memory database: four UNKNOWN
 *        intents built from known transactions, then the state machine decides
 *          A  Phase 14 kev payment (really settled)        → SETTLED
 *          B  Phase 14 cve payment, recorded with the wrong
 *             amount                                        → stays UNKNOWN, SETTLEMENT_MISMATCH
 *          C  a transaction ID from an hour ago that never
 *             reached consensus                             → FAILED, TX_EXPIRED_NOT_FOUND
 *          D  a transaction ID from just now                → stays UNKNOWN, NOT_YET_VISIBLE
 *        and shows that none of them can be signed again and that reopening
 *        the same purchase returns the same intent.
 *
 * Needs HEDERA_MIRROR_NODE_URL and the payer account ID (public;
 * HEDERA_PAYER_ACCOUNT_ID or --payer). No key is loaded.
 */
import type { ProviderAgent } from '../../packages/core/src/domain/index.ts';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  MirrorNodeClient,
  hashscanTransactionUrl,
  toMirrorTransactionId,
} from '../../packages/hedera/src/index.ts';
import { openDatabase } from '../../apps/server/src/db/database.ts';
import { SqlitePaymentStore } from '../../apps/server/src/payments/payment-store.ts';
import {
  PaymentStateError,
  PaymentStateMachine,
} from '../../apps/server/src/payments/state-machine.ts';
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
const payer = argValue('--payer') ?? source['HEDERA_PAYER_ACCOUNT_ID'];
if (payer === undefined || !/^0\.0\.\d+$/.test(payer))
  throw new UsageError('set HEDERA_PAYER_ACCOUNT_ID in .env (or pass --payer 0.0.x)');
const network = env.require('HEDERA_NETWORK') as 'testnet' | 'mainnet';
const mirror = new MirrorNodeClient(env.require('HEDERA_MIRROR_NODE_URL'));
const proof = hasFlag('--proof');
const startedAt = new Date().toISOString();

const { db } = openDatabase(proof ? ':memory:' : env.require('DATABASE_PATH'));
const store = new SqlitePaymentStore(db);
const sm = new PaymentStateMachine(store);

const FEE_PAYER = '0.0.7162784';
const RUN = '00000000-0000-4000-8000-0000000000a1';

interface ProofCase {
  readonly name: string;
  readonly provider: ProviderAgent;
  readonly capability: string;
  readonly requestUrl: string;
  readonly transactionId: string;
  readonly expect: 'SETTLED' | 'MISMATCH' | 'FAILED' | 'PENDING';
}

const agent = (label: string, payTo: string, price: string, capability: string): ProviderAgent => ({
  ensName: `${label}.chirag126.eth`,
  label,
  chain: 'sepolia',
  resolver: '0x0000000000000000000000000000000000000001',
  endpoint: `http://127.0.0.1:4021/v1/${label}`,
  capabilities: [capability],
  payTo,
  network: `hedera:${network}`,
  asset: '0.0.0',
  priceAtomic: price,
  discoveredAt: startedAt,
});

const txIdAt = (ms: number) => {
  const secs = Math.floor(ms / 1000);
  return `${FEE_PAYER}@${secs}.${String(ms % 1000).padStart(3, '0')}${'424242'}`;
};

if (proof) {
  if (network !== 'testnet') throw new UsageError('--proof uses Hedera testnet transactions');
  db.prepare(
    `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES (?, 'manual', '["proof"]', 'RUNNING', ?)`,
  ).run(RUN, startedAt);
  const cases: ProofCase[] = [
    {
      name: 'A Phase 14 kev payment (settled on chain)',
      provider: agent('kev', '0.0.11044329', '100000', 'known-exploited-vulns'),
      capability: 'known-exploited-vulns',
      requestUrl: 'http://127.0.0.1:4021/v1/kev/recent?proof=a',
      transactionId: '0.0.7162784@1793050556.369688880',
      expect: 'SETTLED',
    },
    {
      name: 'B Phase 14 cve payment, wrong amount recorded',
      provider: agent('cve', '0.0.11183141', '100000', 'cve-details'),
      capability: 'cve-details',
      requestUrl: 'http://127.0.0.1:4021/v1/cve/lookup?proof=b',
      transactionId: '0.0.7162784@1793050568.006396277',
      expect: 'MISMATCH',
    },
    {
      name: 'C never reached consensus (an hour ago)',
      provider: agent('osv', '0.0.11183142', '120000', 'package-vulns'),
      capability: 'package-vulns',
      requestUrl: 'http://127.0.0.1:4021/v1/osv/query?proof=c',
      transactionId: txIdAt(Date.now() - 3_600_000),
      expect: 'FAILED',
    },
    {
      name: 'D just signed, not visible yet',
      provider: agent('osv', '0.0.11183142', '120000', 'package-vulns'),
      capability: 'package-vulns',
      requestUrl: 'http://127.0.0.1:4021/v1/osv/query?proof=d',
      transactionId: txIdAt(Date.now()),
      expect: 'PENDING',
    },
  ];

  // Walk each to UNKNOWN exactly as a real payment would get there.
  const ids = new Map<string, string>();
  for (const c of cases) {
    const { intent } = await sm.open({
      runId: RUN,
      provider: c.provider,
      capability: c.capability,
      requestUrl: c.requestUrl,
    });
    await sm.decide(intent.id, {
      allow: true,
      amount: BigInt(c.provider.priceAtomic),
      provider: c.provider,
      intent: { provider: c.provider.ensName, capability: c.capability, rationale: 'proof' },
      runCommittedAfter: 0n,
      dayCommittedAfter: 0n,
    });
    await sm.recordSigned(intent.id, c.transactionId, 'https://api.testnet.blocky402.com');
    await sm.recordSubmitted(intent.id);
    await sm.recordUnknown(intent.id, 'PROOF_UNKNOWN');
    ids.set(c.name, intent.id);
  }

  const results = [];
  for (const c of cases) {
    const id = ids.get(c.name) ?? '';
    const entries = await mirror.getTransactions(toMirrorTransactionId(c.transactionId));
    const r = await sm.reconcile(id, entries, payer, {
      mirrorNode: mirror.baseUrl,
      mirrorNetwork: network,
    });
    let resign = 'not attempted';
    try {
      await sm.recordSigned(
        id,
        `${FEE_PAYER}@1700000000.000000001`,
        'https://api.testnet.blocky402.com',
      );
      resign = 'SIGNED (BUG)';
    } catch (error) {
      resign = error instanceof PaymentStateError ? `refused ${error.code}` : String(error);
    }
    const reopened = await sm.open({
      runId: RUN,
      provider: c.provider,
      capability: c.capability,
      requestUrl: c.requestUrl,
    });
    const ok =
      r.outcome === c.expect &&
      resign.startsWith('refused') &&
      !reopened.created &&
      reopened.intent.id === id;
    results.push({
      name: c.name,
      transactionId: c.transactionId,
      hashscan: hashscanTransactionUrl(network, c.transactionId),
      mirrorEntries: entries.map((e) => ({
        transactionId: e.transactionId,
        result: e.result,
        consensusTimestamp: e.consensusTimestamp,
        transfers: e.transfers,
      })),
      expect: c.expect,
      outcome: r.outcome,
      status: r.intent.status,
      errorCode: r.intent.errorCode,
      resignAttempt: resign,
      reopenedSameIntent: !reopened.created && reopened.intent.id === id,
      history: await store.history(id),
      ok,
    });
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(46)} expect ${c.expect.padEnd(8)} got ${r.outcome.padEnd(8)} → ${r.intent.status}${r.intent.errorCode === null ? '' : ` (${r.intent.errorCode})`} · re-sign ${resign}`,
    );
  }
  const verified = results.length === 4 && results.every((r) => r.ok);
  if (hasFlag('--save-evidence')) {
    const path = writeEvidence(
      'hedera',
      verified ? 'payments-reconcile-proof' : 'payments-reconcile-proof-attempt',
      {
        kind: 'payment-state-machine-reconcile-proof',
        startedAt,
        finishedAt: new Date().toISOString(),
        network: `hedera:${network}`,
        mirrorNode: mirror.baseUrl,
        payer,
        results,
        signedAnything: false,
        verified,
      },
    );
    console.log(`\nEvidence written to ${path}`);
  }
  console.log(
    verified
      ? '\nRECONCILIATION VERIFIED ON THE MIRROR NODE: settled, mismatch, expired and pending each handled; nothing re-signable.'
      : '\nNOT VERIFIED: see the FAIL lines above.',
  );
  if (!verified) process.exitCode = 1;
} else {
  const open = await store.listByStatus(['SUBMITTED', 'UNKNOWN']);
  console.log(`${open.length} payment(s) SUBMITTED or UNKNOWN in ${env.require('DATABASE_PATH')}`);
  for (const p of open) {
    if (p.transactionId === null) continue;
    const entries = await mirror.getTransactions(toMirrorTransactionId(p.transactionId));
    const r = await sm.reconcile(p.id, entries, payer, {
      mirrorNode: mirror.baseUrl,
      mirrorNetwork: network,
    });
    console.log(
      `  ${p.id}  ${p.provider.padEnd(22)} ${p.transactionId}  ${p.status} → ${r.intent.status} (${r.outcome}${r.intent.errorCode === null ? '' : `, ${r.intent.errorCode}`})`,
    );
  }
}
db.close();
