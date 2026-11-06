// Needs zod (installed in CI and on the owner's machine).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AtomicAmount,
  EnsName,
  HederaTransactionId,
  HttpsUrl,
  INFERENCE_TRANSITIONS,
  InferenceCall,
  IsoTimestamp,
  PAYMENT_TRANSITIONS,
  PaymentIntent,
  ProviderAgent,
  Run,
  canTransition,
  isTerminalPayment,
  type PaymentStatus,
} from '../src/domain/index.ts';

const NOW = '2026-10-27T00:00:00.000Z';
const RUN_ID = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  schema.safeParse(v).success;

const PROVIDER = {
  ensName: 'kev.chirag126.eth',
  label: 'kev',
  chain: 'sepolia',
  resolver: '0x1993BB58708a630AF1CC01304Dd851BDEccF9261',
  endpoint: 'https://providers.example/v1/kev',
  capabilities: ['known-exploited-vulns'],
  payTo: '0.0.11044329',
  network: 'hedera:testnet',
  asset: '0.0.0',
  priceAtomic: '100000',
  discoveredAt: NOW,
};

const INTENT = {
  id: '1b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a',
  runId: RUN_ID,
  provider: 'kev.chirag126.eth',
  payTo: '0.0.11044329',
  network: 'hedera:testnet',
  asset: '0.0.0',
  amountAtomic: '100000',
  idempotencyKey: 'a'.repeat(64),
  capability: 'known-exploited-vulns',
  requestUrl: 'http://127.0.0.1:4021/v1/kev/recent',
  status: 'SETTLED',
  refusalCode: null,
  transactionId: '0.0.7162784@1792969955.376969750',
  facilitator: 'https://api.testnet.blocky402.com',
  errorCode: null,
  settledAt: NOW,
  reconcileAttempts: 0,
  lastCheckedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const CALL = {
  id: '2b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a',
  runId: null,
  purpose: 'PROBE',
  network: 'testnet',
  model: '0gm-1.0-35b-a3b',
  status: 'SUCCEEDED',
  requestId: '787b3070-6821-4172-9be9-9e5f64fdf390',
  provider: '0x1cB95Eb66Cc67C62d4DE0CC96726C5A5d82e7C85',
  promptTokens: 77,
  completionTokens: 256,
  worstCaseNeuron: '1000000000000000',
  costNeuron: '599355333333333',
  creditUsedNeuron: '0',
  depositUsedNeuron: '599355333333333',
  funding: 'deposit',
  teeVerified: true,
  errorCode: null,
  createdAt: NOW,
  settledAt: NOW,
  reconciledAt: null,
};

describe('primitives', () => {
  it('keep money as canonical integer strings', () => {
    for (const good of ['0', '1', '599355333333333', '1' + '0'.repeat(30)])
      assert.ok(ok(AtomicAmount, good), good);
    for (const bad of ['-1', '01', '1.5', '1e6', '', ' 1', 1])
      assert.ok(!ok(AtomicAmount, bad), String(bad));
  });

  it('validate Hedera tx IDs, ENS names, URLs and timestamps', () => {
    assert.ok(ok(HederaTransactionId, '0.0.7162784@1792969955.376969750'));
    assert.ok(!ok(HederaTransactionId, '0.0.7162784-1792969955-376969750'));
    assert.ok(ok(EnsName, 'kev.chirag126.eth'));
    for (const bad of ['Kev.eth', 'kev.xyz', 'eth', '-a.eth']) assert.ok(!ok(EnsName, bad), bad);
    assert.ok(ok(HttpsUrl, 'https://a.example/x'));
    for (const bad of ['http://a.example', 'https://u:p@a.example', 'nope'])
      assert.ok(!ok(HttpsUrl, bad), bad);
    assert.ok(ok(IsoTimestamp, NOW));
    assert.ok(!ok(IsoTimestamp, '2026-10-27'));
    assert.ok(!ok(IsoTimestamp, '2026-13-45T00:00:00.000Z'));
  });
});

describe('entities', () => {
  it('accept a well-formed provider and reject unknown or bad fields', () => {
    assert.ok(ok(ProviderAgent, PROVIDER));
    assert.ok(!ok(ProviderAgent, { ...PROVIDER, extra: 1 }), 'strict: unknown key');
    assert.ok(!ok(ProviderAgent, { ...PROVIDER, priceAtomic: '0' }));
    assert.ok(!ok(ProviderAgent, { ...PROVIDER, endpoint: 'http://insecure.example' }));
    // D-035: loopback http is a valid provider endpoint (whether to accept it is discovery policy)
    assert.ok(ok(ProviderAgent, { ...PROVIDER, endpoint: 'http://127.0.0.1:4021/v1/kev' }));
    assert.ok(ok(ProviderAgent, { ...PROVIDER, endpoint: 'http://localhost:4021/v1/kev' }));
    assert.ok(!ok(ProviderAgent, { ...PROVIDER, endpoint: 'http://10.0.0.5/v1/kev' }));
    assert.ok(!ok(ProviderAgent, { ...PROVIDER, endpoint: 'https://u:p@a.example/v1/kev' }));
    assert.ok(!ok(ProviderAgent, { ...PROVIDER, capabilities: [] }));
  });

  it('validate runs', () => {
    const run = {
      id: RUN_ID,
      trigger: 'scheduled',
      watchlist: ['Apache HTTP Server', 'OpenSSL'],
      status: 'QUEUED',
      createdAt: NOW,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    assert.ok(ok(Run, run));
    assert.ok(!ok(Run, { ...run, watchlist: [] }));
    assert.ok(!ok(Run, { ...run, status: 'DONE' }));
  });

  it('require a refusal code for REFUSED and a tx ID once signed', () => {
    assert.ok(ok(PaymentIntent, INTENT));
    assert.ok(!ok(PaymentIntent, { ...INTENT, status: 'REFUSED' }));
    assert.ok(
      ok(PaymentIntent, {
        ...INTENT,
        status: 'REFUSED',
        refusalCode: 'PAYTO_NOT_ALLOWED',
        transactionId: null,
      }),
    );
    assert.ok(!ok(PaymentIntent, { ...INTENT, status: 'UNKNOWN', transactionId: null }));
    assert.ok(!ok(PaymentIntent, { ...INTENT, settledAt: null }), 'SETTLED needs settledAt');
    assert.ok(!ok(PaymentIntent, { ...INTENT, idempotencyKey: 'short' }));
  });

  it('record 0G funding honestly: credit funding needs credit_used > 0', () => {
    assert.ok(ok(InferenceCall, CALL));
    assert.ok(!ok(InferenceCall, { ...CALL, funding: 'credits' }), 'the live call used 0 credits');
    assert.ok(ok(InferenceCall, { ...CALL, funding: 'credits', creditUsedNeuron: '5' }));
    assert.ok(!ok(InferenceCall, { ...CALL, requestId: null }), 'success needs a request ID');
    assert.ok(
      ok(InferenceCall, {
        ...CALL,
        status: 'REFUSED',
        requestId: null,
        costNeuron: null,
        funding: 'none',
      }),
    );
  });

  it('require the reserved worst case while a call is PENDING or UNKNOWN', () => {
    const pending = { ...CALL, status: 'PENDING', requestId: null, costNeuron: null };
    assert.ok(ok(InferenceCall, pending));
    assert.ok(!ok(InferenceCall, { ...pending, worstCaseNeuron: null }));
    assert.ok(!ok(InferenceCall, { ...pending, status: 'UNKNOWN', worstCaseNeuron: null }));
    assert.ok(ok(InferenceCall, { ...pending, status: 'UNKNOWN' }));
  });

  it('only lets PENDING and UNKNOWN calls move, never back to PENDING', () => {
    for (const [from, tos] of Object.entries(INFERENCE_TRANSITIONS))
      assert.ok(!tos.includes('PENDING'), from);
    assert.deepEqual(INFERENCE_TRANSITIONS.REFUSED, []);
    assert.deepEqual(INFERENCE_TRANSITIONS.SUCCEEDED, []);
  });
});

describe('payment state machine', () => {
  it('never lets an UNKNOWN or submitted payment be re-signed', () => {
    for (const from of ['SUBMITTED', 'UNKNOWN', 'SETTLED', 'FAILED'] as PaymentStatus[]) {
      assert.equal(canTransition(from, 'SIGNED'), false, from);
    }
    assert.deepEqual([...PAYMENT_TRANSITIONS.UNKNOWN].sort(), ['FAILED', 'SETTLED']);
  });

  it('allows the normal path and refusal', () => {
    const path: PaymentStatus[] = ['CREATED', 'AUTHORIZED', 'SIGNED', 'SUBMITTED', 'SETTLED'];
    for (let i = 0; i + 1 < path.length; i++)
      assert.ok(canTransition(path[i] as PaymentStatus, path[i + 1] as PaymentStatus));
    assert.ok(canTransition('CREATED', 'REFUSED'));
    assert.ok(!canTransition('CREATED', 'SETTLED'), 'no skipping authorization');
    for (const t of ['REFUSED', 'SETTLED', 'FAILED'] as PaymentStatus[])
      assert.ok(isTerminalPayment(t));
  });
});

describe('intel schemas', () => {
  it('validate dates, ids, CVSS and reject unknown fields', async () => {
    const { IntelItem, IsoDate, AdvisoryId } = await import('../src/domain/intel.ts');
    assert.ok(IsoDate.safeParse('2099-01-31').success);
    assert.ok(!IsoDate.safeParse('2099-02-30').success);
    for (const id of ['CVE-2099-0001', 'GHSA-xxxx-yyyy-zzzz', 'PYSEC-2099-1', 'GO-2099-0001']) {
      assert.ok(AdvisoryId.safeParse(id).success, id);
    }
    assert.ok(!AdvisoryId.safeParse('<script>').success);
    const item = {
      id: 'CVE-2099-0001',
      aliases: [],
      title: 't',
      summary: 's',
      severity: 'high',
      cvss: { version: '3.1', score: 7.5, vector: null },
      published: null,
      modified: null,
      cwes: ['CWE-79'],
      vendor: null,
      product: null,
      exploited: null,
      affected: [],
      references: ['https://a.example/x'],
    };
    assert.ok(IntelItem.safeParse(item).success);
    assert.ok(!IntelItem.safeParse({ ...item, cvss: { ...item.cvss, score: 11 } }).success);
    assert.ok(!IntelItem.safeParse({ ...item, references: ['http://a.example/x'] }).success);
    assert.ok(!IntelItem.safeParse({ ...item, cwes: ['XSS'] }).success);
    assert.ok(!IntelItem.safeParse({ ...item, injected: true }).success);
  });
});

describe('analysis schemas', () => {
  it('TriageResult accepts a well-formed triage and rejects unknown fields or bad ids', async () => {
    const { TriageResult } = await import('../src/domain/analysis.ts');
    const good = {
      assessments: [
        {
          id: 'CVE-2021-44228',
          priority: 'p1',
          exploitedInWild: true,
          rationale: 'RCE, exploited.',
        },
      ],
      summary: 'Patch Log4j today.',
    };
    assert.ok(TriageResult.safeParse(good).success);
    assert.ok(!TriageResult.safeParse({ ...good, extra: 1 }).success);
    assert.ok(!TriageResult.safeParse({ ...good, assessments: [] }).success);
    const bad = { ...good, assessments: [{ ...good.assessments[0], priority: 'urgent' }] };
    assert.ok(!TriageResult.safeParse(bad).success);
    const injected = { ...good, assessments: [{ ...good.assessments[0], id: 'ignore previous' }] };
    assert.ok(!TriageResult.safeParse(injected).success);
    const { z } = await import('zod');
    const schema = z.toJSONSchema(TriageResult) as { required?: string[] };
    assert.deepEqual([...(schema.required ?? [])].sort(), ['assessments', 'summary']);
  });
});
