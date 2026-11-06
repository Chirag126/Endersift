/**
 * LIVE check of the running API (plan row 26): one real task through HTTP and
 * the live event stream, plus the access-code and rate-limit behaviour.
 *
 *   pnpm providers:start                                               (terminal 1)
 *   pnpm api:start -- --allow-local-http --from-block 11999808           (terminal 2)
 *   pnpm api:check -- --save-evidence                                    (terminal 3)
 *
 * Options: --base http://127.0.0.1:3001 (default from SERVER_PORT) ·
 * --watchlist "…" · --budget 300000 · --skip-rate-limit
 *
 * Steps: health → task refused without a code → wrong code refused → session
 * cookie → providers and evidence index → POST a task (real payments and 0G
 * calls) → follow its SSE stream to the end → task detail, events, report →
 * (last) hammer /api/health until 429 with Retry-After. The access code comes
 * from DEMO_ACCESS_CODE in .env and is never printed or saved.
 */
import { loadServerConfig } from '../apps/server/src/config.ts';
import { MIGRATIONS } from '../apps/server/src/db/migrations.ts';
import { parseSse } from './lib/sse.ts';
import {
  UsageError,
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from './lib/cli.ts';

handleScriptErrors();

// the running server must be on this checkout's schema
const LATEST_MIGRATION = MIGRATIONS.at(-1)?.id ?? 0;

const config = loadServerConfig(loadLocalEnvSource());
const code = config.demoAccessCode;
if (code === null) throw new UsageError('set DEMO_ACCESS_CODE in .env (the API needs it too)');
const base = (argValue('--base') ?? `http://127.0.0.1:${config.port}`).replace(/\/+$/, '');
const watchlist = argValue('--watchlist') ?? 'OpenSSL, lodash@4.17.20 (npm), Microsoft Windows';
const budget = argValue('--budget') ?? '300000';
const startedAt = new Date().toISOString();

interface EvidenceFile {
  readonly path: string;
  readonly verified: boolean | null;
}
interface TaskInfo {
  readonly id: string;
  readonly status: string;
  readonly error: string | null;
}
interface PaymentInfo {
  readonly provider: string;
  readonly status: string;
  readonly transactionId: string | null;
  readonly hashscan: string | null;
}
interface CallInfo {
  readonly purpose: string;
  readonly status: string;
  readonly requestId: string | null;
}
type MaybeTask = TaskInfo | undefined;
type MaybeFiles = EvidenceFile[] | undefined;
type MaybeList = unknown[] | undefined;

interface Step {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const steps: Step[] = [];
const step = (name: string, ok: boolean, detail = '') => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}`);
};
const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;
const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

console.log(`LIVE API check against ${base} · watchlist "${watchlist}" · budget ${budget}\n`);

// 1. health
const health = await call('/api/health').catch((e: unknown) => {
  throw new UsageError(
    `the API is not reachable at ${base} (${e instanceof Error ? e.message : String(e)}); start it with pnpm api:start`,
  );
});
const h = await json(health);
step(
  'health',
  health.status === 200 && h['migration'] === LATEST_MIGRATION,
  `migration ${String(h['migration'])}`,
);
step(
  'security headers',
  health.headers.get('x-content-type-options') === 'nosniff' &&
    health.headers.get('cache-control') === 'no-store',
);

// 2. access control
const noCode = await postJson('/api/tasks', { watchlist });
step('task refused without an access code', noCode.status === 401, `HTTP ${noCode.status}`);
const wrong = await postJson('/api/session', { code: `${code}-wrong` });
step('wrong access code refused', wrong.status === 401, `HTTP ${wrong.status}`);
const login = await postJson('/api/session', { code });
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(';')[0] ?? '';
step(
  'session cookie for the right code',
  login.status === 204 && /HttpOnly/.test(setCookie) && /Path=\/api/.test(setCookie),
  /SameSite=\w+/.exec(setCookie)?.[0] ?? 'no cookie',
);

// 3. public reads
const providers = (await json(await call('/api/providers')))['providers'];
step(
  'providers',
  Array.isArray(providers),
  `${Array.isArray(providers) ? providers.length : 0} known`,
);
const evidenceBody = await json(await call('/api/evidence'));
const evidence = evidenceBody['files'] as MaybeFiles;
step(
  'evidence index lists the verified live run',
  evidence?.some((f) => f.path.startsWith('e2e/agent-run-') && f.verified === true) ?? false,
  `${evidence?.length ?? 0} files`,
);

// 4. a real task
const created = await postJson('/api/tasks', { watchlist, budget }, { cookie });
const c = await json(created);
const task = c['task'] as MaybeTask;
step(
  'task accepted (202)',
  created.status === 202 && task?.status === 'QUEUED',
  task?.id ?? `HTTP ${created.status}`,
);
if (task === undefined) throw new UsageError(`the task was not accepted: ${JSON.stringify(c)}`);

console.log('\nfollowing the event stream ...');
const streamRes = await call(`/api/tasks/${task.id}/stream`);
const events = parseSse(await streamRes.text());
for (const e of events)
  if (e.event !== 'end') console.log(`  ${String(e.id ?? '').padStart(2)}  ${e.event}`);
const ids = events.filter((e) => e.id !== null).map((e) => Number(e.id));
const end = events.at(-1);
step(
  'stream: every event in order, then end',
  streamRes.status === 200 && ids.every((id, i) => id === i) && end?.event === 'end',
  `${ids.length} events, end ${end?.data ?? '-'}`,
);

const detail = await json(await call(`/api/tasks/${task.id}`));
const run = detail['task'] as TaskInfo;
const payments = (detail['payments'] as PaymentInfo[] | undefined) ?? [];
const inference = (detail['inference'] as CallInfo[] | undefined) ?? [];
const settled = payments.filter((p) => p.status === 'SETTLED');
step('task SUCCEEDED', run.status === 'SUCCEEDED', run.error ?? '');
step(
  'settled payments carry HashScan links',
  settled.length > 0 && settled.every((p) => p.hashscan !== null),
  settled.map((p) => `${p.provider} ${p.transactionId}`).join(', '),
);
step(
  '0G PLAN and ANALYZE recorded',
  ['PLAN', 'ANALYZE'].every((purpose) =>
    inference.some(
      (x) => x.purpose === purpose && x.status === 'SUCCEEDED' && x.requestId !== null,
    ),
  ),
  inference.map((x) => `${x.purpose} ${x.requestId}`).join(', '),
);
const tailBody = await json(
  await call(`/api/tasks/${task.id}/events?after=${Math.max(0, ids.length - 3)}`),
);
const tail = tailBody['events'] as MaybeList;
step('events after a sequence number', (tail?.length ?? 0) === Math.min(2, ids.length - 1));
const reportRes = await call(`/api/tasks/${task.id}/report`);
const report = await reportRes.text();
step(
  'brief served as markdown, citing the settled tx IDs',
  reportRes.status === 200 &&
    /^text\/markdown/.test(reportRes.headers.get('content-type') ?? '') &&
    settled.every((p) => report.includes(String(p.transactionId))),
  `${report.length} chars`,
);
const skipped = events
  .filter((e) => e.event === 'PURCHASE_SKIPPED')
  .map((e) => {
    const d = JSON.parse(e.data) as { payload?: { code?: string } };
    return d.payload?.code ?? '?';
  });
console.log(
  `  purchases skipped before payment: ${skipped.length === 0 ? 'none' : skipped.join(', ')}`,
);

// 5. rate limit (last: it blocks this client for up to a minute)
let limited: { status: number; retryAfter: string | null; after: number } | null = null;
if (!hasFlag('--skip-rate-limit')) {
  for (let i = 1; i <= 200; i += 1) {
    const r = await call('/api/health');
    if (r.status === 429) {
      limited = { status: 429, retryAfter: r.headers.get('retry-after'), after: i };
      break;
    }
  }
  step(
    'rate limit: 429 with Retry-After',
    limited !== null && Number(limited.retryAfter) > 0,
    limited === null
      ? 'never limited'
      : `after ${limited.after} requests, retry after ${limited.retryAfter}s`,
  );
}

const verified = steps.every((s) => s.ok);
if (hasFlag('--save-evidence')) {
  const path = writeEvidence('api', verified ? 'api-check' : 'api-check-attempt', {
    kind: 'api-live-check',
    startedAt,
    finishedAt: new Date().toISOString(),
    base,
    input: { watchlist, budget },
    steps,
    task: detail,
    stream: events.map((e) => ({ id: e.id, event: e.event })),
    skippedBeforePayment: skipped,
    rateLimit: limited,
    report,
    verified,
  });
  console.log(`\nEvidence written to ${path}`);
}
console.log(
  verified
    ? `\nAPI VERIFIED: ${steps.length}/${steps.length} steps; one live task through HTTP and SSE with ${settled.length} settled payment(s).`
    : '\nNOT VERIFIED: see the FAIL lines above.',
);
if (!verified) process.exitCode = 1;
