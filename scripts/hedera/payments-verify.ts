/**
 * Settlement verifier against the REAL Mirror Node (plan row 22). Nothing is signed.
 *
 *   pnpm payments:verify                    on DATABASE_PATH
 *   pnpm payments:verify -- --save-evidence
 *
 * 1. Reconciles every SUBMITTED / UNKNOWN payment.
 * 2. Audits every SETTLED payment: re-reads its transaction now and records the
 *    verification (status, payee, payer, amount, network, token transfers, timing).
 * 3. Checks the invariant: every SETTLED payment has a SETTLED Mirror Node
 *    verification for its own transaction ID.
 * 4. Probes (in-memory copy, real Mirror Node data of the newest SETTLED
 *    payment): the true expectation settles; a wrong payee, a wrong amount and
 *    the wrong network do not; marking SETTLED without a verification is
 *    refused by the database.
 * Exit 0 only if all of that holds and at least one payment was audited.
 */
import { randomUUID } from 'node:crypto';
import type { ProviderAgent } from '../../packages/core/src/domain/index.ts';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  MirrorNodeClient,
  hashscanTransactionUrl,
  toMirrorTransactionId,
} from '../../packages/hedera/src/index.ts';
import { openDatabase } from '../../apps/server/src/db/database.ts';
import { SqlitePaymentStore } from '../../apps/server/src/payments/payment-store.ts';
import { SettlementVerifier } from '../../apps/server/src/payments/settlement-verifier.ts';
import { PaymentStateMachine } from '../../apps/server/src/payments/state-machine.ts';
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
const databasePath = env.require('DATABASE_PATH');
const startedAt = new Date().toISOString();

const { db } = openDatabase(databasePath);
const store = new SqlitePaymentStore(db);
const machine = new PaymentStateMachine(store);
const verifier = new SettlementVerifier({ machine, store, mirror, network, payer });

console.log(
  `settlement verifier on hedera:${network} · Mirror Node ${mirror.baseUrl} · ${databasePath}\n`,
);

// 1. open payments
const open = await verifier.reconcileOpen();
console.log(`open payments reconciled: ${open.length}`);
for (const r of open)
  console.log(`  ${r.intent.id}  ${r.intent.transactionId}  → ${r.intent.status} (${r.outcome})`);

// 2. audit SETTLED
const audit = await verifier.audit();
console.log(`\nSETTLED payments audited: ${audit.length}`);
for (const a of audit)
  console.log(
    `  ${a.confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'}  ${a.intent.provider.padEnd(20)} ${a.intent.amountAtomic.padStart(7)} → ${a.intent.payTo}  ${a.intent.transactionId}  consensus ${a.verification.consensusTimestamp ?? '-'}`,
  );

// 3. invariant
const settled = await store.listByStatus(['SETTLED']);
const invariant = [];
for (const p of settled) {
  const vs = await store.verifications(p.id);
  const ok = vs.some((v) => v.outcome === 'SETTLED' && v.transactionId === p.transactionId);
  const beforeSettle = vs.some(
    (v) =>
      v.outcome === 'SETTLED' &&
      v.transactionId === p.transactionId &&
      v.verifiedAt <= (p.settledAt ?? ''),
  );
  invariant.push({
    id: p.id,
    transactionId: p.transactionId,
    ok,
    verifiedBeforeSettled: beforeSettle,
  });
}
const invariantOk = invariant.every((i) => i.ok);
console.log(
  `\ninvariant: ${invariant.filter((i) => i.ok).length}/${invariant.length} SETTLED payments carry a SETTLED Mirror Node verification` +
    ` (${invariant.filter((i) => i.verifiedBeforeSettled).length} verified at settlement time; older ones settled before the verifier existed and are confirmed by this audit)`,
);

// 4. probes on the newest SETTLED payment's real Mirror Node data
const newest = [...settled]
  .sort((a, b) => (a.settledAt ?? '').localeCompare(b.settledAt ?? ''))
  .at(-1);
const probes: { name: string; expect: string; got: string; ok: boolean }[] = [];
if (newest !== undefined && newest.transactionId !== null) {
  const txId = newest.transactionId;
  const entries = await mirror.getTransactions(toMirrorTransactionId(txId));
  /** A fresh in-memory database per probe: transaction IDs are unique per database. */
  const fresh = () => {
    const mem = openDatabase(':memory:').db;
    const run = randomUUID();
    mem
      .prepare(
        `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES (?, 'manual', '["probe"]', 'RUNNING', ?)`,
      )
      .run(run, startedAt);
    const memStore = new SqlitePaymentStore(mem);
    return { mem, run, memMachine: new PaymentStateMachine(memStore) };
  };
  const base: ProviderAgent = {
    ensName: newest.provider,
    label: newest.provider.split('.')[0] ?? 'probe',
    chain: 'sepolia',
    resolver: '0x0000000000000000000000000000000000000001',
    endpoint: `http://127.0.0.1:4021/v1/${newest.provider.split('.')[0] ?? 'probe'}`,
    capabilities: [newest.capability],
    payTo: newest.payTo,
    network: newest.network,
    asset: newest.asset,
    priceAtomic: newest.amountAtomic,
    discoveredAt: startedAt,
  };
  const probe = async (
    name: string,
    provider: ProviderAgent,
    expect: string,
    mirrorNetwork: 'testnet' | 'mainnet' = network,
  ) => {
    const { mem, run, memMachine } = fresh();
    const { intent } = await memMachine.open({
      runId: run,
      provider,
      capability: newest.capability,
      requestUrl: `${provider.endpoint}/probe?${encodeURIComponent(name)}`,
    });
    await memMachine.decide(intent.id, {
      allow: true,
      amount: BigInt(provider.priceAtomic),
      provider,
      intent: { provider: provider.ensName, capability: newest.capability, rationale: 'probe' },
      runCommittedAfter: 0n,
      dayCommittedAfter: 0n,
    });
    await memMachine.recordSigned(intent.id, txId, 'https://api.testnet.blocky402.com');
    await memMachine.recordSubmitted(intent.id);
    const r = await memMachine.reconcile(intent.id, entries, payer, {
      mirrorNode: mirror.baseUrl,
      mirrorNetwork,
    });
    const got = `${r.intent.status}${r.intent.errorCode === null ? '' : ` ${r.intent.errorCode}`}`;
    probes.push({ name, expect, got, ok: got === expect });
    mem.close();
  };
  await probe('true expectation', base, 'SETTLED');
  await probe('wrong payee', { ...base, payTo: '0.0.9999999' }, 'SUBMITTED SETTLEMENT_MISMATCH');
  await probe(
    'wrong amount',
    { ...base, priceAtomic: (BigInt(base.priceAtomic) + 1n).toString() },
    'SUBMITTED SETTLEMENT_MISMATCH',
  );
  await probe(
    'Mirror Node of the other network',
    base,
    'SUBMITTED NETWORK_MISMATCH',
    network === 'testnet' ? 'mainnet' : 'testnet',
  );
  // marking SETTLED without a verification, straight in SQL
  const { mem, run, memMachine } = fresh();
  const { intent } = await memMachine.open({
    runId: run,
    provider: base,
    capability: newest.capability,
    requestUrl: `${base.endpoint}/probe?raw`,
  });
  let raw = 'not refused';
  try {
    mem.prepare("UPDATE payment_intents SET status = 'AUTHORIZED' WHERE id = ?").run(intent.id);
    mem
      .prepare(
        "UPDATE payment_intents SET status = 'SIGNED', transaction_id = ?, facilitator = 'https://x.example' WHERE id = ?",
      )
      .run(`${txId.split('@')[0]}@1700000000.000000001`, intent.id);
    mem.prepare("UPDATE payment_intents SET status = 'SUBMITTED' WHERE id = ?").run(intent.id);
    mem
      .prepare("UPDATE payment_intents SET status = 'SETTLED', settled_at = ? WHERE id = ?")
      .run(startedAt, intent.id);
  } catch (error) {
    raw =
      error instanceof Error && /SETTLED only after a Mirror Node verification/.test(error.message)
        ? 'refused'
        : String(error);
  }
  probes.push({
    name: 'SETTLED without a verification (raw SQL)',
    expect: 'refused',
    got: raw,
    ok: raw === 'refused',
  });
  mem.close();
  console.log(`\nprobes on ${txId} (real Mirror Node data):`);
  for (const p of probes)
    console.log(
      `  ${p.ok ? 'OK  ' : 'FAIL'} ${p.name.padEnd(42)} expect ${p.expect.padEnd(30)} got ${p.got}`,
    );
}

const verified =
  audit.length > 0 &&
  audit.every((a) => a.confirmed) &&
  invariantOk &&
  probes.length === 5 &&
  probes.every((p) => p.ok);
if (hasFlag('--save-evidence')) {
  const path = writeEvidence(
    'hedera',
    verified ? 'settlement-verifier' : 'settlement-verifier-attempt',
    {
      kind: 'settlement-verifier-audit',
      startedAt,
      finishedAt: new Date().toISOString(),
      network: `hedera:${network}`,
      mirrorNode: mirror.baseUrl,
      payer,
      reconciledOpen: open.map((r) => ({
        id: r.intent.id,
        transactionId: r.intent.transactionId,
        status: r.intent.status,
        outcome: r.outcome,
      })),
      audit: audit.map((a) => ({
        id: a.intent.id,
        provider: a.intent.provider,
        payTo: a.intent.payTo,
        amount: a.intent.amountAtomic,
        transactionId: a.intent.transactionId,
        hashscan:
          a.intent.transactionId === null
            ? null
            : hashscanTransactionUrl(network, a.intent.transactionId),
        settledAt: a.intent.settledAt,
        confirmed: a.confirmed,
        verification: a.verification,
      })),
      invariant,
      probes,
      signedAnything: false,
      verified,
    },
  );
  console.log(`\nEvidence written to ${path}`);
}
console.log(
  verified
    ? `\nSETTLEMENT VERIFIED BY THE MIRROR NODE: ${audit.length} SETTLED payment(s) confirmed; wrong payee, amount and network refused; SETTLED is impossible without a verification.`
    : '\nNOT VERIFIED: see the lines above (no SETTLED payment to audit yet? run pnpm x402:buy first).',
);
db.close();
if (!verified) process.exitCode = 1;
