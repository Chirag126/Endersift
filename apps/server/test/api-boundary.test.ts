// Class: unit. What leaves the API about a run (D-053): secrets redacted at
// the boundary, and the run verdict the UI may show. A failed or mock run, or
// one with an unresolved payment, is never "end-to-end verified".
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crossSiteRefused, type OriginCheckInput } from '../src/api/origin.ts';
import { REDACTED, isSensitiveKey, redactText, redactValue } from '../src/api/redact.ts';
import { severityOf, stageOf, summarizeRun, type EventLike } from '../src/api/run-summary.ts';
import { limitParam } from '../src/api/server.ts';

describe('redaction', () => {
  it('names that say "secret" are replaced; counts and evidence are not', () => {
    for (const k of [
      'privateKey',
      'HEDERA_PAYER_PRIVATE_KEY',
      'apiKey',
      'zg_api_key',
      'authorization',
      'accessCode',
      'sessionToken',
      'token',
      'cookie',
      'mnemonic',
    ])
      assert.ok(isSensitiveKey(k), k);
    for (const k of [
      'maxTokens',
      'promptTokens',
      'planMaxTokens',
      'transactionId',
      'requestId',
      'payTo',
      'blockNumber',
    ])
      assert.ok(!isSensitiveKey(k), k);
  });

  it('credential-shaped text is replaced inside any string', () => {
    const der = `302e020100300506032b657004220420${'1f'.repeat(32)}`;
    const cases: [string, string][] = [
      ['auth: Bearer abc.def-ghi_jkl', `auth: Bearer ${REDACTED}`],
      [`key=${der}`, `key=${REDACTED}`],
      [`evm 0x${'a1'.repeat(32)} end`, `evm ${REDACTED} end`],
      [`router sk-${'k'.repeat(32)}`, `router ${REDACTED}`],
      ['https://user:pa55@rpc.example/v1', `https://${REDACTED}@rpc.example/v1`],
      ['https://rpc.example/v1?apikey=abc123&x=1', `https://rpc.example/v1?apikey=${REDACTED}&x=1`],
    ];
    for (const [input, expected] of cases) assert.equal(redactText(input), expected, input);
    // evidence stays: tx IDs, addresses (20 bytes), request IDs, ENS names
    const keep =
      '0.0.7162784@1793113618.672975790 0x1993BB58708a630AF1CC01304Dd851BDEccF9261 5d2c1e0a-0000-4000-8000-000000000001 kev.chirag126.eth';
    assert.equal(redactText(keep), keep);
  });

  it('walks objects and arrays without changing the original', () => {
    const input = { a: [{ apiKey: 'k1', n: 3 }], note: 'Bearer zzzzzzzzzz', nothing: null };
    const out = redactValue(input) as typeof input;
    assert.deepEqual(out, {
      a: [{ apiKey: REDACTED, n: 3 }],
      note: `Bearer ${REDACTED}`,
      nothing: null,
    });
    assert.equal(input.a[0]?.apiKey, 'k1');
  });
});

const ev = (type: string, payload: Record<string, unknown> = {}): EventLike => ({ type, payload });
const FULL: EventLike[] = [
  ev('RUN_STARTED', { environment: 'live', origin: 'api', policy: { version: 2 } }),
  ev('PROVIDERS_DISCOVERED', { blockNumber: '12004338', providers: [{}, {}] }),
  ev('CATALOG_READ', { ok: true }),
  ev('CATALOG_READ', { ok: true }),
  ev('INFERENCE_CALLED', { purpose: 'PLAN', status: 'SUCCEEDED' }),
  ev('PLAN_CREATED', { purchases: [{}, {}] }),
  ev('PAYMENT_AUTHORIZED'),
  ev('PAYMENT_SETTLED', { transactionId: '0.0.1@1.2' }),
  ev('DATA_FETCHED'),
  ev('PAYMENT_REFUSED', { code: 'OVER_RUN_BUDGET' }),
  ev('INFERENCE_CALLED', { purpose: 'ANALYZE', status: 'SUCCEEDED' }),
  ev('ANALYSIS_COMPLETED', { accepted: true, items: 4 }),
  ev('REPORT_WRITTEN'),
  ev('RUN_FINISHED'),
];
const outcomes = (s: ReturnType<typeof summarizeRun>) =>
  Object.fromEntries(s.stages.map((x) => [x.stage, x.outcome]));

describe('run summary', () => {
  it('a live run that paid, verified, analysed and reported is end-to-end verified (a refusal is fine)', () => {
    const s = summarizeRun(FULL, 'SUCCEEDED', 'live');
    assert.equal(s.verdict, 'e2e-verified');
    assert.deepEqual(s.gaps, []);
    assert.equal(s.origin, 'api');
    assert.equal(s.policyVersion, 2);
    assert.deepEqual(outcomes(s), {
      discovery: 'done',
      catalogs: 'done',
      plan: 'done',
      payments: 'partial',
      verification: 'done',
      analysis: 'done',
      report: 'done',
    });
  });

  it('the same events from the mock harness are labelled mock, never verified', () => {
    const mock = FULL.map((e) =>
      e.type === 'RUN_STARTED' ? ev('RUN_STARTED', { environment: 'mock' }) : e,
    );
    const s = summarizeRun(mock, 'SUCCEEDED', 'live');
    assert.equal(s.verdict, 'mock');
    assert.ok(s.gaps.some((g) => /mock run/.test(g)));
  });

  it('a failed run is failed, with the stage that stopped it, and later stages not reached', () => {
    const events = [
      ...FULL.slice(0, 5),
      ev('RUN_FAILED', { code: 'PLAN_FAILED', message: 'OUTPUT_SCHEMA_INVALID' }),
    ];
    const s = summarizeRun(events, 'FAILED', 'live');
    assert.equal(s.verdict, 'failed');
    assert.equal(s.failureCode, 'PLAN_FAILED');
    const o = outcomes(s);
    assert.equal(o['plan'], 'failed');
    assert.equal(o['payments'], 'not-reached');
    assert.equal(o['report'], 'not-reached');
  });

  it('an unknown payment outcome or a missing analysis leaves a succeeded run with gaps', () => {
    const unknown = FULL.map((e) => (e.type === 'PAYMENT_SETTLED' ? ev('PAYMENT_UNKNOWN') : e));
    const s = summarizeRun(unknown, 'SUCCEEDED', 'live');
    assert.equal(s.verdict, 'completed-with-gaps');
    assert.ok(s.gaps.some((g) => /unknown/.test(g)));
    assert.equal(outcomes(s)['verification'], 'failed');
  });

  it('analysis accepted without an ANALYZE call is skipped, with a gap, never verified (D-083)', () => {
    const empty = FULL.filter(
      (e) => !(e.type === 'INFERENCE_CALLED' && e.payload['purpose'] === 'ANALYZE'),
    ).map((e) =>
      e.type === 'ANALYSIS_COMPLETED'
        ? ev('ANALYSIS_COMPLETED', { accepted: true, items: 0, note: 'no advisories' })
        : e,
    );
    const s = summarizeRun(empty, 'SUCCEEDED', 'live');
    assert.equal(s.verdict, 'completed-with-gaps');
    assert.equal(outcomes(s)['analysis'], 'skipped');
    assert.ok(s.gaps.some((g) => /0G was not called/.test(g)));
  });

  it('catalogs still being read are in progress, not failed, while the run is running (D-083)', () => {
    const first = [
      ...FULL.slice(0, 2),
      ev('CATALOG_READ', { ok: false, code: 'CATALOG_UNREACHABLE' }),
    ];
    const s = summarizeRun(first, 'RUNNING', 'live');
    assert.equal(outcomes(s)['catalogs'], 'running');
    assert.equal(outcomes(s)['plan'], 'not-reached');
    // once the run has ended, the same failure is the stage's outcome
    const ended = summarizeRun(
      [...first, ev('RUN_FAILED', { code: 'NO_CATALOG' })],
      'FAILED',
      'live',
    );
    assert.equal(outcomes(ended)['catalogs'], 'failed');
  });

  it('runs recorded before environment labels take the server mode, marked inferred', () => {
    const legacy = FULL.map((e) => (e.type === 'RUN_STARTED' ? ev('RUN_STARTED', {}) : e));
    const live = summarizeRun(legacy, 'SUCCEEDED', 'live');
    assert.equal(live.environmentSource, 'inferred');
    assert.equal(live.verdict, 'e2e-verified');
    assert.equal(summarizeRun(legacy, 'SUCCEEDED', 'mock').verdict, 'mock');
  });

  it('a running run shows the stage in progress and is never verified', () => {
    const s = summarizeRun(FULL.slice(0, 6), 'RUNNING', 'live');
    assert.equal(s.verdict, 'in-progress');
    assert.equal(outcomes(s)['payments'], 'running');
    assert.equal(outcomes(s)['analysis'], 'not-reached');
  });

  it('stage and severity of single events (for the log)', () => {
    assert.equal(stageOf(ev('PAYMENT_SETTLED')), 'verification');
    assert.equal(stageOf(ev('INFERENCE_CALLED', { purpose: 'ANALYZE' })), 'analysis');
    assert.equal(stageOf(ev('RUN_STARTED')), null);
    assert.equal(severityOf(ev('PAYMENT_REFUSED')), 'warning');
    assert.equal(severityOf(ev('RUN_FAILED')), 'error');
    assert.equal(severityOf(ev('ANALYSIS_COMPLETED', { accepted: false })), 'error');
    assert.equal(severityOf(ev('PAYMENT_SETTLED')), 'success');
    assert.equal(severityOf(ev('CATALOG_READ', { ok: true })), 'info');
  });
});

describe('cross-site writes (D-060)', () => {
  const base = {
    method: 'POST',
    origin: undefined,
    secFetchSite: undefined,
    host: 'api.example:3001',
    corsOrigin: 'https://app.example',
  } as const;
  const refused = (o: Partial<OriginCheckInput>) => crossSiteRefused({ ...base, ...o });

  it('reads and preflights are never refused here', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get'])
      assert.equal(refused({ method, secFetchSite: 'cross-site' }), false, method);
  });

  it('the browser says where a write comes from: only same-origin and none pass', () => {
    assert.equal(refused({ secFetchSite: 'same-origin' }), false);
    assert.equal(refused({ secFetchSite: 'none' }), false);
    assert.equal(refused({ secFetchSite: 'same-site' }), true);
    assert.equal(refused({ secFetchSite: 'cross-site' }), true);
    assert.equal(refused({ method: 'DELETE', secFetchSite: 'cross-site' }), true);
    // the configured frontend is cross-site by design
    assert.equal(refused({ origin: 'https://app.example', secFetchSite: 'cross-site' }), false);
  });

  it('without Sec-Fetch-Site the Origin must match the Host (or be absent)', () => {
    assert.equal(refused({}), false); // curl and the check scripts
    assert.equal(refused({ origin: 'http://api.example:3001' }), false);
    assert.equal(refused({ origin: 'https://evil.example' }), true);
    assert.equal(refused({ origin: 'null' }), true);
    assert.equal(refused({ origin: 'not a url' }), true);
    assert.equal(refused({ origin: 'https://app.example', corsOrigin: null }), true);
  });
});

describe('limit parameters (D-060)', () => {
  it('are integers clamped to [1, max]; anything else is the default', () => {
    assert.equal(limitParam(null, 20, 100), 20);
    assert.equal(limitParam('5', 20, 100), 5);
    assert.equal(limitParam('0', 20, 100), 1);
    assert.equal(limitParam('100000', 20, 100), 100);
    for (const bad of ['-1', '1.5', '1e3', ' 5', 'x', '9999999'])
      assert.equal(limitParam(bad, 20, 100), 20, bad);
  });
});
