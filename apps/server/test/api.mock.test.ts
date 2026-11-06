// Class: mock. NOT live verification. The HTTP API on a real local socket,
// driving the MOCK orchestrator harness (real store, firewall, buyer,
// verifier, ledger; fake ENS, providers, signer, Mirror Node, Router).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { API_CSP, createApi, type ApiLimits, type ApiOptions } from '../src/api/server.ts';
import { TaskRunner } from '../src/api/task-runner.ts';
import { APP_CSP, appCsp, byteRange, loadStaticSite } from '../src/api/static.ts';
import { createRun, saveReport } from '../src/db/repositories.ts';
import {
  BUY_KEV,
  BUY_OSV,
  NOW,
  PUBLIC_CONFIG,
  analysisJson,
  harness,
  planJson,
} from './support/orchestrator-harness.ts';

const CODE = 'test-access-code-123';
const HARNESS_OFFSET_MS = NOW.getTime() - Date.now();
const servers: Server[] = [];
const dirs: string[] = [];
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function start(
  o: {
    limits?: Partial<ApiLimits>;
    corsOrigin?: string | null;
    maxPending?: number;
    outsideSpend?: ApiOptions['outsideSpend'];
    webRoot?: string;
    connectOrigins?: readonly string[];
  } = {},
) {
  const h = harness({
    plan: () => planJson([BUY_KEV, BUY_OSV]),
    analysis: () => analysisJson(['CVE-2026-1001', 'GHSA-aaaa-bbbb-cccc']),
  });
  const runner = new TaskRunner(h.orchestrator, { maxPending: o.maxPending ?? 3 });
  const root = mkdtempSync(join(tmpdir(), 'evidence-'));
  dirs.push(root);
  mkdirSync(join(root, 'e2e'));
  writeFileSync(join(root, 'e2e', 'agent-run-1.json'), '{"kind":"agent-run-live","verified":true}');
  writeFileSync(join(root, 'secret.txt'), 'not evidence');
  mkdirSync(join(root, 'zg'));
  // older result flags count; a misleading flag name does not
  writeFileSync(
    join(root, 'zg', 'ledger-1.json'),
    '{"kind":"zg-ledger","ledgerMatchesRouterUsage":true}',
  );
  writeFileSync(
    join(root, 'zg', 'inference-1.json'),
    '{"kind":"zg-inference","creditFundedInferenceVerified":true}',
  );
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  dirs.push(outside);
  writeFileSync(join(outside, 'x.json'), '{"leak":true}');
  // A directory junction (Windows) / symlink (elsewhere) pointing outside the evidence folder.
  // Junctions need no admin rights or Developer Mode, unlike file symlinks on Windows.
  symlinkSync(outside, join(root, 'linked'), 'junction');
  const api = createApi({
    db: h.db,
    runner,
    payments: h.store,
    inference: h.ledger,
    accessCode: CODE,
    hashscan: (tx) => `https://hashscan.io/testnet/transaction/${encodeURIComponent(tx)}`,
    migration: 8,
    evidenceRoot: root,
    publicConfig: PUBLIC_CONFIG,
    policy: h.policyStore,
    mode: 'mock',
    schedules: h.scheduleStore,
    corsOrigin: o.corsOrigin ?? null,
    ...(o.outsideSpend === undefined ? {} : { outsideSpend: o.outsideSpend }),
    ...(o.webRoot === undefined ? {} : { webRoot: o.webRoot }),
    ...(o.connectOrigins === undefined ? {} : { connectOrigins: o.connectOrigins }),
    trustProxyHops: 1,
    secureCookies: false,
    limits: o.limits ?? {},
    sse: { pollMs: 10, heartbeatMs: 50 },
    // the API's clock runs on the harness's day (its records are dated 2026-10-27), so "today"
    // means the same UTC day whatever day the tests run on
    now: () => Date.now() + HARNESS_OFFSET_MS,
  });
  const server = createServer((req, res) => void api.handler(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let ip = 0;
  const call = (path: string, init: RequestInit & { client?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set('x-forwarded-for', init.client ?? `203.0.113.${++ip % 250}`);
    return fetch(`${base}${path}`, { ...init, headers });
  };
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    client?: string,
  ) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(client === undefined ? {} : { client }),
    });
  return { h, runner, api, call, post };
}

const auth = { authorization: `Bearer ${CODE}` };

describe('API (mock)', () => {
  it('a task end to end: POST → SSE replay and live → detail, events, report', async () => {
    const t = await start();
    const res = await t.post('/api/tasks', { watchlist: 'OpenSSL, lodash@4.17.21 (npm)' }, auth);
    assert.equal(res.status, 202);
    const created = (await res.json()) as { task: { id: string; status: string }; stream: string };
    assert.equal(created.task.status, 'QUEUED');

    const sse = await t.call(created.stream);
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type') ?? '', /^text\/event-stream/);
    const text = await sse.text(); // the stream ends itself after the terminal event
    const events = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    assert.equal(events[0], 'RUN_STARTED');
    assert.deepEqual(events.slice(-2), ['RUN_FINISHED', 'end']);
    assert.ok(events.includes('PAYMENT_SETTLED'));
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(
      ids,
      ids.map((_, i) => i),
    );
    assert.match(text, /event: end\ndata: \{"status":"SUCCEEDED"\}/);
    await t.runner.idle();

    const detail = (await (await t.call(`/api/tasks/${created.task.id}`)).json()) as {
      task: { status: string };
      payments: { status: string; hashscan: string | null }[];
      inference: { purpose: string }[];
      report: boolean;
      events: number;
    };
    assert.equal(detail.task.status, 'SUCCEEDED');
    assert.deepEqual(
      detail.payments.map((p) => p.status),
      ['SETTLED', 'SETTLED'],
    );
    assert.ok(detail.payments.every((p) => p.hashscan?.startsWith('https://hashscan.io/testnet/')));
    assert.deepEqual(
      detail.inference.map((c) => c.purpose),
      ['PLAN', 'ANALYZE'],
    );
    assert.equal(detail.report, true);

    const tail = (await (await t.call(`/api/tasks/${created.task.id}/events?after=13`)).json()) as {
      events: { seq: number }[];
    };
    assert.deepEqual(
      tail.events.map((e) => e.seq),
      [14, 15],
    );
    const report = await t.call(`/api/tasks/${created.task.id}/report`);
    assert.match(report.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.match(await report.text(), /^# Threat brief/);

    const list = (await (await t.call('/api/tasks')).json()) as { tasks: { id: string }[] };
    assert.equal(list.tasks[0]?.id, created.task.id);
    const providers = (await (await t.call('/api/providers')).json()) as {
      providers: { ensName: string }[];
    };
    assert.deepEqual(
      providers.providers.map((p) => p.ensName),
      ['kev.chirag126.eth', 'osv.chirag126.eth'],
    );

    // resuming a stream with Last-Event-ID replays only what came after
    const resumed = await (
      await t.call(created.stream, { headers: { 'last-event-id': '14' } })
    ).text();
    assert.deepEqual(
      [...resumed.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])),
      [15],
    );
  });

  it('UI reads: config, session state, provider ENS snapshot, recent payments and 0G ledger', async () => {
    const t = await start();
    // the env config, with the policy the firewall enforces now (no owner version yet: env)
    const base = JSON.parse(JSON.stringify(PUBLIC_CONFIG)) as { policy: Record<string, unknown> };
    assert.deepEqual(await (await t.call('/api/config')).json(), {
      ...base,
      policy: {
        ...base.policy,
        paymentsPaused: false,
        approvalMode: 'autonomous',
        approvalAboveTinybars: '0',
        providerDailyCaps: {},
        source: 'env',
        version: null,
      },
    });
    const empty = (await (await t.call('/api/providers')).json()) as { snapshot: unknown };
    assert.equal(empty.snapshot, null, 'no discovery yet');
    assert.deepEqual(await (await t.call('/api/session')).json(), { authenticated: false });
    assert.deepEqual(await (await t.call('/api/session', { headers: auth })).json(), {
      authenticated: true,
    });

    const res = await t.post('/api/tasks', { watchlist: 'OpenSSL' }, auth);
    const { task } = (await res.json()) as { task: { id: string } };
    await t.runner.idle();

    const providers = (await (await t.call('/api/providers')).json()) as {
      providers: { ensName: string; resolver: string }[];
      snapshot: { runId: string; blockNumber: string; parent: string } | null;
    };
    assert.equal(providers.snapshot?.blockNumber, '12004338');
    assert.equal(providers.snapshot?.runId, task.id);
    assert.equal(providers.snapshot?.parent, 'chirag126.eth');
    assert.match(providers.providers[0]?.resolver ?? '', /^0x[0-9a-fA-F]{40}$/);

    const payments = (await (await t.call('/api/payments?limit=10')).json()) as {
      payments: { runId: string; status: string; hashscan: string | null }[];
      today: { committedAtomic: string };
    };
    assert.deepEqual(
      payments.payments.map((p) => p.status),
      ['SETTLED', 'SETTLED'],
    );
    assert.ok(payments.payments.every((p) => p.runId === task.id && p.hashscan !== null));
    assert.equal(typeof payments.today.committedAtomic, 'string');

    const inference = (await (await t.call('/api/inference')).json()) as {
      calls: { purpose: string; requestId: string }[];
      today: { calls: number; spentNeuron: string };
    };
    assert.deepEqual(
      inference.calls.map((c) => c.purpose),
      ['ANALYZE', 'PLAN'],
      'newest first',
    );
    assert.ok(inference.today.calls >= 2);
    assert.match(inference.today.spentNeuron, /^\d+$/);
  });

  it('starting a task needs the access code: bearer or session cookie; failures are limited', async () => {
    const t = await start({ limits: { authFailuresPer15Min: 3 } });
    const body = { watchlist: ['OpenSSL'] };
    assert.equal((await t.post('/api/tasks', body)).status, 401);
    const wrong = await t.post('/api/tasks', body, { authorization: 'Bearer nope' });
    assert.equal(wrong.status, 401);
    assert.deepEqual(await wrong.json(), {
      error: 'ACCESS_DENIED',
      message: 'a valid access code is required',
    });

    // session: wrong code refused, right code → HttpOnly cookie
    assert.equal((await t.post('/api/session', { code: 'nope' }, {}, '198.51.100.1')).status, 401);
    const login = await t.post('/api/session', { code: CODE }, {}, '198.51.100.2');
    assert.equal(login.status, 204);
    const cookie = login.headers.get('set-cookie') ?? '';
    assert.match(
      cookie,
      /^ae_session=[A-Za-z0-9_-]{22}\.\d{13,15}\.[A-Za-z0-9_-]{43}; HttpOnly; Path=\/api; Max-Age=43200; SameSite=Strict$/,
    );
    const session = cookie.split(';')[0] ?? '';
    assert.equal((await t.post('/api/tasks', body, { cookie: session })).status, 202);
    const logout = await t.call('/api/session', { method: 'DELETE', headers: { cookie: session } });
    assert.equal(logout.status, 204);
    assert.equal((await t.post('/api/tasks', body, { cookie: session })).status, 401);

    // brute force: after 3 failures from one client, even the right code waits
    const c = '192.0.2.77';
    for (let i = 0; i < 3; i += 1)
      assert.equal(
        (await t.post('/api/tasks', body, { authorization: 'Bearer x' }, c)).status,
        401,
      );
    const blocked = await t.post('/api/tasks', body, auth, c);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    await t.runner.idle();
  });

  it('validates input and records nothing for a refused request', async () => {
    const t = await start();
    const count = () => (t.h.db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;
    const raw = (body: string, type = 'application/json') =>
      t.call('/api/tasks', { method: 'POST', headers: { ...auth, 'content-type': type }, body });
    const code = async (r: Promise<Response>) =>
      ((await (await r).json()) as { error: string }).error;
    assert.equal(await code(raw('{}', 'text/plain')), 'UNSUPPORTED_MEDIA_TYPE');
    assert.equal(await code(raw('{nope')), 'INVALID_JSON');
    assert.equal(await code(raw('[1]')), 'INVALID_BODY');
    assert.equal(
      await code(raw(JSON.stringify({ watchlist: 'x', payTo: '0.0.666' }))),
      'UNKNOWN_FIELD',
    );
    assert.equal(await code(raw(JSON.stringify({ watchlist: '' }))), 'INVALID_WATCHLIST');
    assert.equal(await code(raw(JSON.stringify({ watchlist: [1] }))), 'INVALID_WATCHLIST');
    assert.equal(await code(raw(JSON.stringify({ watchlist: 'x', budget: 5 }))), 'INVALID_BUDGET');
    const over = await raw(JSON.stringify({ watchlist: 'x', budget: '3000001' }));
    assert.equal(over.status, 400);
    assert.match(((await over.json()) as { message: string }).message, /3000000/);
    const big = await raw(JSON.stringify({ watchlist: 'x'.repeat(20_000) }));
    assert.equal(big.status, 413);
    assert.equal(count(), 0);
    assert.equal((await t.call('/api/nope')).status, 404);
    const wrongMethod = await t.call('/api/providers', { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
    assert.equal((await t.call('/api/tasks/00000000-0000-4000-8000-000000000000')).status, 404);
  });

  it('rate limits requests and task starts per client, with Retry-After', async () => {
    const t = await start({ limits: { requestsPerMinute: 3, tasksPerHour: 1 } });
    const c = '192.0.2.10';
    for (let i = 0; i < 3; i += 1)
      assert.equal((await t.call('/api/health', { client: c })).status, 200);
    const limited = await t.call('/api/health', { client: c });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await t.call('/api/health', { client: '192.0.2.11' })).status, 200);

    const d = '192.0.2.20';
    assert.equal((await t.post('/api/tasks', { watchlist: 'a' }, auth, d)).status, 202);
    const second = await t.post('/api/tasks', { watchlist: 'b' }, auth, d);
    assert.equal(second.status, 429);
    assert.equal(((await second.json()) as { error: string }).error, 'TOO_MANY_TASKS');
    await t.runner.idle();
  });

  it('caps open event streams per client', async () => {
    const t = await start({ limits: { streamsPerClient: 1 } });
    // a queued task that is never executed keeps its stream open
    const run = t.h.orchestrator.queue({ trigger: 'manual', watchlist: ['x'] });
    const c = '192.0.2.30';
    const first = await t.call(`/api/tasks/${run.id}/stream`, { client: c });
    assert.equal(first.status, 200);
    const second = await t.call(`/api/tasks/${run.id}/stream`, { client: c });
    assert.equal(second.status, 429);
    assert.equal(((await second.json()) as { error: string }).error, 'TOO_MANY_STREAMS');
    // heartbeats keep the open stream alive
    const reader = first.body?.getReader();
    let seen = '';
    while (!seen.includes(': ping') && reader !== undefined) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    assert.match(seen, /^retry: 3000/);
    assert.match(seen, /: ping/);
    t.api.closeStreams();
    assert.equal(t.api.openStreams(), 0);
    await reader?.cancel();
  });

  it('serves the evidence index and files, and nothing outside the evidence folder', async () => {
    const t = await start();
    const index = (await (await t.call('/api/evidence')).json()) as {
      files: { path: string; kind: string; verified: boolean | null }[];
    };
    assert.deepEqual(
      index.files.map((f) => [f.path, f.kind, f.verified]),
      [
        ['e2e/agent-run-1.json', 'agent-run-live', true],
        ['zg/inference-1.json', 'zg-inference', null],
        ['zg/ledger-1.json', 'zg-ledger', true],
      ],
    );
    const file = await t.call('/api/evidence/e2e/agent-run-1.json');
    assert.equal(file.status, 200);
    assert.deepEqual(await file.json(), { kind: 'agent-run-live', verified: true });
    for (const path of [
      '/api/evidence/linked/x.json', // junction / symlink pointing outside (would be 200 without the realpath check)
      '/api/evidence/e2e/..%2F..%2Fsecret.txt',
      '/api/evidence/../secret.txt',
      '/api/evidence/e2e/missing.json',
    ])
      assert.equal((await t.call(path)).status, 404, path);
  });

  it('security headers on every response; CORS only for the configured origin', async () => {
    const t = await start({ corsOrigin: 'https://app.example' });
    const res = await t.call('/api/health', { headers: { origin: 'https://app.example' } });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    const other = await t.call('/api/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const preflight = await t.call('/api/tasks', {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example' },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/);
    const bad = await t.call('/api/tasks', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(bad.status, 403);
    // cross-site https frontend → SameSite=None; Secure session cookie
    const login = await t.post('/api/session', { code: CODE });
    assert.match(login.headers.get('set-cookie') ?? '', /SameSite=None; Secure$/);
  });

  it('a deny-all CSP on every response, errors included (D-060)', async () => {
    const t = await start();
    for (const path of ['/api/health', '/api/nope']) {
      const res = await t.call(path);
      assert.equal(res.headers.get('content-security-policy'), API_CSP, path);
      assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin', path);
    }
  });

  it('cross-site writes are refused before any handler, even with the code (D-060)', async () => {
    const t = await start({ corsOrigin: 'https://app.example' });
    const body = { watchlist: 'OpenSSL' };
    const refused = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site', origin: 'https://other.app.example' },
      { origin: 'https://evil.example' },
      { origin: 'null' },
    ];
    for (const headers of refused) {
      const res = await t.post('/api/tasks', body, { ...auth, ...headers });
      assert.equal(res.status, 403, JSON.stringify(headers));
      assert.equal(((await res.json()) as { error: string }).error, 'CROSS_SITE_REFUSED');
    }
    assert.equal(t.h.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.['n'], 0);
    // a cross-site logout is refused too; reads are not affected
    const logout = await t.call('/api/session', {
      method: 'DELETE',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(logout.status, 403);
    const read = await t.call('/api/health', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(read.status, 200);
    // allowed: the configured frontend, the same origin, and scripts without an Origin
    for (const headers of [
      { origin: 'https://app.example', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-origin' },
      {},
    ]) {
      const res = await t.post('/api/session', { code: CODE }, headers);
      assert.equal(res.status, 204, JSON.stringify(headers));
    }
  });

  it('the brief is redacted on the way out like every other outside text (D-060)', async () => {
    const t = await start();
    const id = '0b5e3f4e-1d2c-4b5a-9e8f-7a6b5c4d3e2f';
    const at = new Date(Date.now() + HARNESS_OFFSET_MS).toISOString();
    createRun(t.h.db, {
      id,
      trigger: 'manual',
      watchlist: ['OpenSSL'],
      status: 'QUEUED',
      createdAt: at,
      startedAt: null,
      finishedAt: null,
      error: null,
    });
    const key = ['abcdefgh', 'ijklmnop', 'qrst'].join('');
    saveReport(t.h.db, {
      runId: id,
      markdown: `# Brief\n\nquoted: https://eth-sepolia.g.alchemy.com/v2/${key} and Bearer ${key}\n`,
      createdAt: at,
    });
    const text = await (await t.call(`/api/tasks/${id}/report`)).text();
    assert.ok(!text.includes(key), text);
    assert.match(text, /alchemy\.com\/v2\/\[redacted\]/);
  });

  it("today's spend shows the Mirror Node reading of payments outside this database (D-062)", async () => {
    const none = await start();
    const a = (await (await none.call('/api/payments')).json()) as {
      today: { outside: unknown };
    };
    assert.equal(a.today.outside, null);
    const day = new Date(Date.now() + HARNESS_OFFSET_MS).toISOString().slice(0, 10);
    const t = await start({
      outsideSpend: () => ({
        day,
        tinybars: 250_000n,
        count: 2,
        readAt: `${day}T08:00:00.000Z`,
      }),
    });
    const b = (await (await t.call('/api/payments')).json()) as {
      today: { outside: { atomic: string; count: number; readAt: string } };
    };
    assert.deepEqual(b.today.outside, {
      atomic: '250000',
      count: 2,
      readAt: `${day}T08:00:00.000Z`,
    });
    const stale = await start({
      outsideSpend: () => ({ day: '2026-01-01', tinybars: 1n, count: 1, readAt: 'x' }),
    });
    const c = (await (await stale.call('/api/payments')).json()) as { today: { outside: unknown } };
    assert.equal(c.today.outside, null, "another day's reading is not shown");
  });

  it('the page may also fetch the provider host it wakes, and nothing else (D-085)', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'dist-wake-'));
    dirs.push(dist);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
    const t = await start({
      webRoot: dist,
      connectOrigins: ['https://threat-intel-providers.onrender.com'],
    });
    const csp = (await t.call('/')).headers.get('content-security-policy') ?? '';
    assert.equal(csp, appCsp(['https://threat-intel-providers.onrender.com']));
    assert.match(csp, /connect-src 'self' https:\/\/threat-intel-providers\.onrender\.com;/);
    assert.match(csp, /script-src 'self';/);
    assert.equal(appCsp(), APP_CSP);
  });

  it('serves the built web app on the same origin, from memory, with the app CSP (D-062)', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'dist-'));
    dirs.push(dist);
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dist, 'assets', 'index-abc.js'), 'console.log(1)');
    writeFileSync(join(dist, 'assets', 'index-abc.js.map'), '{}');
    mkdirSync(join(dist, 'audio'));
    writeFileSync(join(dist, 'audio', 'click.mp3'), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    writeFileSync(join(dist, '.env'), 'SECRET=1');
    const outside = mkdtempSync(join(tmpdir(), 'outside-web-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'leak.html'), 'leak');
    symlinkSync(outside, join(dist, 'linked'), 'junction');
    const t = await start({ webRoot: dist });

    const page = await t.call('/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(page.headers.get('content-security-policy'), APP_CSP);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(await page.text(), '<!doctype html><title>app</title>');
    const js = await t.call('/assets/index-abc.js');
    assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/);
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    // EnderPay audio (D-073): served as audio/mpeg, byte for byte
    const mp3 = await t.call('/audio/click.mp3');
    assert.equal(mp3.status, 200);
    assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
    assert.deepEqual([...new Uint8Array(await mp3.arrayBuffer())], [0xff, 0xfb, 0x90, 0x00]);
    // byte ranges, so a track can start at its set position (D-074)
    assert.equal(mp3.headers.get('accept-ranges'), 'bytes');
    const part = await t.call('/audio/click.mp3', { headers: { range: 'bytes=1-2' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 1-2/4');
    assert.equal(part.headers.get('content-length'), '2');
    assert.equal(part.headers.get('content-type'), 'audio/mpeg');
    assert.equal(part.headers.get('content-security-policy'), APP_CSP);
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [0xfb, 0x90]);
    const rest = await t.call('/audio/click.mp3', { headers: { range: 'bytes=2-' } });
    assert.equal(rest.status, 206);
    assert.deepEqual([...new Uint8Array(await rest.arrayBuffer())], [0x90, 0x00]);
    const beyond = await t.call('/audio/click.mp3', { headers: { range: 'bytes=9-' } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get('content-range'), 'bytes */4');
    await beyond.arrayBuffer();
    const several = await t.call('/audio/click.mp3', { headers: { range: 'bytes=0-0,2-3' } });
    assert.equal(several.status, 200);
    assert.equal((await several.arrayBuffer()).byteLength, 4);
    const head = await t.call('/index.html', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const path of [
      '/assets/index-abc.js.map',
      '/.env',
      '/linked/leak.html',
      '/assets/../.env',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/missing',
    ])
      assert.equal((await t.call(path)).status, 404, path);
    // the API is unchanged next to it
    const health = await t.call('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('content-security-policy'), API_CSP);
    assert.equal((await t.call('/api/nope')).status, 404);
    assert.equal((await t.call('/', { method: 'POST' })).status, 404);
  });

  it('byte ranges: one range only; anything odd sends the whole file (D-074)', () => {
    assert.equal(byteRange(undefined, 10), null);
    assert.deepEqual(byteRange('bytes=0-3', 10), { start: 0, end: 3 });
    assert.deepEqual(byteRange('bytes=4-', 10), { start: 4, end: 9 });
    assert.deepEqual(byteRange('bytes=8-99', 10), { start: 8, end: 9 });
    assert.deepEqual(byteRange('bytes=-3', 10), { start: 7, end: 9 });
    assert.deepEqual(byteRange('bytes=-30', 10), { start: 0, end: 9 });
    assert.equal(byteRange('bytes=10-', 10), 'unsatisfiable');
    assert.equal(byteRange('bytes=-0', 10), 'unsatisfiable');
    assert.equal(byteRange('bytes=5-2', 10), null);
    assert.equal(byteRange('bytes=0-1,4-5', 10), null);
    assert.equal(byteRange('items=0-1', 10), null);
    assert.equal(byteRange('bytes=-', 10), null);
    assert.equal(byteRange('bytes=99999999999999999999-', 10), null);
  });

  it('refuses to start with a web folder that has no index.html', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dist-empty-'));
    dirs.push(empty);
    assert.throws(() => loadStaticSite(empty), /no index\.html/);
    assert.throws(() => loadStaticSite(join(empty, 'nope')), /cannot be read/);
  });

  it('list limits are clamped: a negative limit is not "no limit" (D-060)', async () => {
    const t = await start();
    const res = await t.post('/api/tasks', { watchlist: 'OpenSSL' }, auth);
    assert.equal(res.status, 202);
    for (const path of ['/api/payments?limit=-1', '/api/tasks?limit=-1', '/api/inference?limit=x'])
      assert.equal((await t.call(path)).status, 200, path);
    const tasks = (await (await t.call('/api/tasks?limit=-1')).json()) as { tasks: unknown[] };
    assert.equal(tasks.tasks.length, 1);
  });
});

// ── owner policy, kill switch, run summaries, logs, redaction (D-052, D-053) ──

const put = (
  t: Awaited<ReturnType<typeof start>>,
  body: unknown,
  headers: Record<string, string> = auth,
) =>
  t.call('/api/policy', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

interface PolicyBody {
  effective: Record<string, unknown>;
  ceiling: Record<string, unknown>;
  source: string;
  version: number | null;
  reason: string | null;
  enforcement: Record<string, boolean>;
  history: { version: number; paymentsPaused: boolean }[];
}

const LOWER = {
  maxPerPayment: '200000',
  maxPerRun: '500000',
  maxPerDay: '2000000',
  maxPaymentsPerRun: 3,
  paymentsPaused: false,
};

describe('API (mock): owner spending policy', () => {
  it('shows the env policy until the owner saves one, and says what enforces it', async () => {
    const t = await start();
    const p = (await (await t.call('/api/policy')).json()) as PolicyBody;
    assert.equal(p.source, 'env');
    assert.equal(p.version, null);
    assert.deepEqual(p.effective, p.ceiling);
    assert.equal(p.effective['paymentsPaused'], false);
    assert.deepEqual(p.enforcement, {
      firewall: true,
      killSwitch: true,
      providerCaps: true,
      approvals: true,
      ensPublished: false,
    });
    assert.deepEqual(p.history, []);
  });

  it('saving needs the access code and is validated against the env ceiling on the server', async () => {
    const t = await start();
    assert.equal((await put(t, { ...LOWER, expectedVersion: null }, {})).status, 401);
    const over = await put(t, { ...LOWER, maxPerRun: '999999999', expectedVersion: null });
    assert.equal(over.status, 400);
    const body = (await over.json()) as { error: string; problems: string[] };
    assert.equal(body.error, 'POLICY_INVALID');
    assert.ok(body.problems.some((x) => /above the server ceiling/.test(x)));
    const bad = (await (
      await put(t, {
        maxPerPayment: '-5',
        maxPerRun: '100',
        maxPerDay: '50',
        maxPaymentsPerRun: 0,
        paymentsPaused: 'yes',
        expectedVersion: null,
        admin: true,
      })
    ).json()) as { problems: string[] };
    for (const re of [
      /unknown field/,
      /maxPerPayment must be/,
      /maxPerRun must not be above maxPerDay/,
      /maxPaymentsPerRun must be/,
      /paymentsPaused/,
    ])
      assert.ok(
        bad.problems.some((x) => re.test(x)),
        String(re),
      );
    // nothing was saved
    assert.equal(((await (await t.call('/api/policy')).json()) as PolicyBody).version, null);
  });

  it('a saved version is in force: config, policy, history; a stale save is refused (409)', async () => {
    const t = await start();
    const saved = await put(t, { ...LOWER, expectedVersion: null, reason: 'tighter for the demo' });
    assert.equal(saved.status, 200);
    const p = (await saved.json()) as PolicyBody;
    assert.equal(p.source, 'owner');
    assert.equal(p.version, 1);
    assert.equal(p.reason, 'tighter for the demo');
    assert.equal(p.effective['maxPerRun'], '500000');
    const config = (await (await t.call('/api/config')).json()) as {
      policy: Record<string, unknown>;
    };
    assert.equal(config.policy['maxPerRun'], '500000');
    assert.equal(config.policy['source'], 'owner');
    // another tab still holding version null cannot overwrite version 1
    const stale = await put(t, { ...LOWER, maxPerRun: '600000', expectedVersion: null });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: string }).error, 'POLICY_CONFLICT');
    // a task budget above the owner's run budget is refused, nothing recorded
    const big = await t.post('/api/tasks', { watchlist: 'OpenSSL', budget: '600000' }, auth);
    assert.equal(big.status, 400);
    assert.equal(
      ((await (await t.call('/api/tasks')).json()) as { tasks: unknown[] }).tasks.length,
      0,
    );
  });

  it('kill switch: new tasks are refused, and resuming lets them run', async () => {
    const t = await start();
    await put(t, { ...LOWER, paymentsPaused: true, expectedVersion: null });
    const refused = await t.post('/api/tasks', { watchlist: 'OpenSSL' }, auth);
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, 'PAYMENTS_PAUSED');
    assert.equal(
      ((await (await t.call('/api/tasks')).json()) as { tasks: unknown[] }).tasks.length,
      0,
    );
    await put(t, { ...LOWER, paymentsPaused: false, expectedVersion: 1 });
    const ok = await t.post('/api/tasks', { watchlist: 'OpenSSL' }, auth);
    assert.equal(ok.status, 202);
    await t.runner.idle();
    const history = ((await (await t.call('/api/policy')).json()) as PolicyBody).history;
    assert.deepEqual(
      history.map((v) => [v.version, v.paymentsPaused]),
      [
        [2, false],
        [1, true],
      ],
    );
  });
});

describe('API (mock): runs, logs and redaction', () => {
  it('run summaries: stages from events, and a mock run is never end-to-end verified', async () => {
    const t = await start();
    const res = await t.post('/api/tasks', { watchlist: 'OpenSSL, lodash@4.17.21 (npm)' }, auth);
    const { task } = (await res.json()) as { task: { id: string } };
    await t.runner.idle();
    const body = (await (await t.call('/api/runs')).json()) as {
      mode: string;
      runs: {
        task: { id: string };
        summary: {
          verdict: string;
          environment: string;
          environmentSource: string;
          origin: string | null;
          stages: { stage: string; outcome: string }[];
          gaps: string[];
        };
        payments: { transactionId: string | null; hashscan: string | null }[];
        inference: { requestId: string | null }[];
      }[];
    };
    assert.equal(body.mode, 'mock');
    const run = body.runs[0];
    assert.equal(run?.task.id, task.id);
    assert.equal(run?.summary.verdict, 'mock');
    assert.equal(run?.summary.environment, 'mock');
    assert.equal(run?.summary.environmentSource, 'recorded');
    assert.equal(run?.summary.origin, 'api');
    assert.deepEqual(
      run?.summary.stages.map((x) => `${x.stage}:${x.outcome}`),
      [
        'discovery:done',
        'catalogs:done',
        'plan:done',
        'payments:done',
        'verification:done',
        'analysis:done',
        'report:done',
      ],
    );
    assert.ok(run?.summary.gaps.some((g) => /mock run/.test(g)));
    assert.ok(run?.payments.every((p) => p.transactionId !== null && p.hashscan !== null));
    assert.ok(run?.inference.every((c) => c.requestId !== null));
  });

  it('logs: newest first, paged with a cursor, with stage and severity', async () => {
    const t = await start();
    await t.post('/api/tasks', { watchlist: 'OpenSSL' }, auth);
    await t.runner.idle();
    type Page = {
      entries: { id: number; seq: number; type: string; stage: string | null; severity: string }[];
      next: number | null;
      total: number;
    };
    const first = (await (await t.call('/api/logs?limit=10')).json()) as Page;
    assert.equal(first.entries.length, 10);
    assert.equal(first.entries[0]?.type, 'RUN_FINISHED');
    assert.equal(first.entries[0]?.severity, 'success');
    const ids = first.entries.map((e) => e.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => b - a),
      'newest first',
    );
    assert.ok(first.next !== null);
    const second = (await (await t.call(`/api/logs?limit=10&before=${first.next}`)).json()) as Page;
    assert.ok(second.entries.length > 0);
    assert.ok(
      second.entries.every((e) => e.id < Math.min(...ids)),
      'older than the first page',
    );
    // one run of fewer than 20 events: two pages hold all of it, ending at its start
    assert.equal(second.next, null);
    assert.equal(first.entries.length + second.entries.length, first.total);
    assert.equal(second.entries.at(-1)?.type, 'RUN_STARTED');
    assert.equal((await t.call('/api/logs?before=abc')).status, 400);
    // live updates: only entries newer than the cursor
    const newer = (await (await t.call(`/api/logs?after=${ids[1]}`)).json()) as Page;
    assert.deepEqual(
      newer.entries.map((e) => e.id),
      [ids[0]],
    );
    const plan = [...first.entries, ...second.entries].find((e) => e.type === 'PLAN_CREATED');
    assert.equal(plan?.stage, 'plan');
  });

  it('redacts secrets from event payloads and run errors at the API boundary', async () => {
    const t = await start();
    const id = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
    const leak = `0x${'ab'.repeat(32)}`;
    t.h.db
      .prepare(
        `INSERT INTO runs (id, trigger, watchlist, status, created_at, error) VALUES (?, 'manual', '["x"]', 'RUNNING', ?, ?)`,
      )
      .run(
        id,
        '2026-10-27T12:00:00.000Z',
        `INTERNAL: fetch https://x.example/a?api_key=SEKRET1 failed`,
      );
    t.h.db
      .prepare(
        `INSERT INTO run_events (run_id, seq, type, payload, at) VALUES (?, 0, 'RUN_STARTED', ?, ?)`,
      )
      .run(
        id,
        JSON.stringify({
          privateKey: 'whatever',
          nested: { authorization: 'Bearer abcdefghijklmnop', note: `key ${leak}` },
          limits: { planMaxTokens: 768 },
          transactionId: '0.0.7162784@1793113618.672975790',
        }),
        '2026-10-27T12:00:00.000Z',
      );
    const texts = [
      await (await t.call(`/api/tasks/${id}/events`)).text(),
      await (await t.call('/api/logs')).text(),
      await (await t.call(`/api/tasks/${id}`)).text(),
      await (await t.call('/api/tasks')).text(),
    ];
    for (const text of texts) {
      for (const secret of ['whatever', 'abcdefghijklmnop', leak, 'SEKRET1'])
        assert.ok(!text.includes(secret), `${secret} leaked`);
    }
    assert.match(texts[0] ?? '', /"planMaxTokens":768/, 'token counts are not secrets');
    assert.match(texts[0] ?? '', /0\.0\.7162784@1793113618\.672975790/, 'evidence stays visible');
  });
});

describe('API (mock): daily watchlist schedules (D-056)', () => {
  const send = (
    t: Awaited<ReturnType<typeof start>>,
    method: 'POST' | 'PUT',
    path: string,
    body: unknown,
    headers: Record<string, string> = auth,
  ) =>
    t.call(path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  interface ScheduleBody {
    id: string;
    watchlist: string[];
    budget: string;
    runAfter: string;
    enabled: boolean;
    nextRunAt: string | null;
    runs: unknown[];
  }

  it('creating needs the access code, is validated against the policy in force, and lists back', async () => {
    const t = await start();
    const body = {
      watchlist: 'OpenSSL, lodash@4.17.21 (npm)',
      budget: '300000',
      runAfter: '00:15',
    };
    assert.equal((await send(t, 'POST', '/api/schedules', body, {})).status, 401);
    const bad = await send(t, 'POST', '/api/schedules', {
      watchlist: '',
      budget: '999999999999',
      runAfter: '25:00',
      enabled: 'yes',
      cron: '* * * * *',
    });
    assert.equal(bad.status, 400);
    const problems = ((await bad.json()) as { problems: string[] }).problems;
    for (const re of [
      /unknown field/,
      /watchlist/,
      /above the run budget in force/,
      /HH:MM/,
      /enabled/,
    ])
      assert.ok(
        problems.some((p) => re.test(p)),
        String(re),
      );
    const created = await send(t, 'POST', '/api/schedules', body);
    assert.equal(created.status, 201);
    const s = (await created.json()) as ScheduleBody;
    assert.deepEqual(s.watchlist, ['OpenSSL', 'lodash@4.17.21 (npm)']);
    assert.equal(s.runAfter, '00:15');
    assert.equal(s.enabled, true);
    assert.ok(s.nextRunAt !== null);
    const list = (await (await t.call('/api/schedules')).json()) as { schedules: ScheduleBody[] };
    assert.equal(list.schedules[0]?.id, s.id);
  });

  it('changing a schedule: disable it, move its time; unknown IDs are 404', async () => {
    const t = await start();
    const s = (await (
      await send(t, 'POST', '/api/schedules', {
        watchlist: ['OpenSSL'],
        budget: '200000',
        runAfter: '00:15',
      })
    ).json()) as ScheduleBody;
    const changed = await send(t, 'PUT', `/api/schedules/${s.id}`, {
      watchlist: ['OpenSSL'],
      budget: '200000',
      runAfter: '06:00',
      enabled: false,
    });
    assert.equal(changed.status, 200);
    const after = (await changed.json()) as ScheduleBody;
    assert.equal(after.runAfter, '06:00');
    assert.equal(after.enabled, false);
    assert.equal(after.nextRunAt, null, 'a disabled schedule never runs');
    const missing = await send(t, 'PUT', '/api/schedules/0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a', {
      watchlist: ['x'],
      budget: '1',
      runAfter: '00:00',
      enabled: true,
    });
    assert.equal(missing.status, 404);
  });

  it('a schedule lists its claimed runs with their verdict and delta', async () => {
    const t = await start();
    const s = t.h.scheduleStore.create({
      watchlist: ['OpenSSL'],
      budget: 300_000n,
      runAfterMinute: 0,
      enabled: true,
    });
    const { run } = t.runner.submit({ trigger: 'scheduled', watchlist: ['OpenSSL'] }, 300_000n, {
      origin: 'scheduler',
      beforeStart: (r) => t.h.scheduleStore.claim(s.id, '2026-10-28', r.id),
    });
    await t.runner.idle();
    const list = (await (await t.call('/api/schedules')).json()) as {
      schedules: {
        runs: { day: string; runId: string; status: string; verdict: string; delta: unknown }[];
      }[];
    };
    const r = list.schedules[0]?.runs[0];
    assert.equal(r?.runId, run.id);
    assert.equal(r?.day, '2026-10-28');
    assert.equal(r?.status, 'SUCCEEDED');
    assert.equal(r?.verdict, 'mock');
    assert.equal(r?.delta, null, 'the first brief has nothing to compare with');
  });
});

describe('API (mock): HCS audit messages (D-057)', () => {
  it('task detail and runs list the audit messages with HashScan links; config names the topic', async () => {
    const t = await start();
    const res = await t.post('/api/tasks', { watchlist: 'OpenSSL' }, auth);
    const { task } = (await res.json()) as { task: { id: string } };
    await t.runner.idle();
    type Audit = {
      kind: string;
      status: string;
      sequenceNumber: string | null;
      hashscan: string;
    }[];
    const detail = (await (await t.call(`/api/tasks/${task.id}`)).json()) as { audit: Audit };
    assert.deepEqual(
      detail.audit.map((a) => [a.kind, a.status]),
      [
        ['settlement', 'CONFIRMED'],
        ['settlement', 'CONFIRMED'],
        ['task', 'CONFIRMED'],
      ],
    );
    assert.ok(
      detail.audit.every((a) => a.hashscan.startsWith('https://hashscan.io/testnet/transaction/')),
    );
    const runs = (await (await t.call('/api/runs')).json()) as { runs: { audit: Audit }[] };
    assert.equal(runs.runs[0]?.audit.length, 3);
    const config = (await (await t.call('/api/config')).json()) as {
      hcs: { topicId: string } | null;
    };
    assert.equal(config.hcs?.topicId, '0.0.9999902');
  });
});
