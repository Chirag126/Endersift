/**
 * The agent's HTTP API and live event stream (plan row 26, D-048). Plain
 * node:http, no framework.
 *
 *   GET    /api/health                       liveness, migration, queue
 *   POST   /api/session        {code}        access code → HttpOnly session cookie
 *   DELETE /api/session                      log out
 *   GET    /api/session                      is this client logged in
 *   GET    /api/config                       non-secret configuration: networks, effective policy, caps
 *   GET    /api/policy                       spending policy in force: source, version, env ceiling, history
 *   PUT    /api/policy         {limits…}     save a new owner policy version (kill switch) [access code]
 *   GET    /api/providers                    providers last discovered on ENS, with the discovery block
 *   GET    /api/payments?limit=              recent payments (HashScan links) and today's committed spend
 *   GET    /api/inference?limit=             recent 0G ledger rows and today's spend
 *   GET    /api/tasks?limit=                 recent tasks (runs)
 *   GET    /api/runs?limit=                  recent runs with their stage outcomes and verdict
 *   GET    /api/logs?limit=&before=&after=   run events across tasks, newest first, with severity
 *   POST   /api/tasks          {watchlist, budget?}   start a task       [access code]
 *   GET    /api/tasks/:id                    task, payments (HashScan), inference, counts
 *   GET    /api/tasks/:id/events?after=      events after a sequence number
 *   GET    /api/tasks/:id/stream             Server-Sent Events: replay, then live, then `end`
 *   GET    /api/tasks/:id/report             the brief (text/markdown)
 *   GET    /api/schedules                    daily watchlist schedules, their runs and deltas
 *   POST   /api/schedules      {watchlist, budget, runAfter, enabled?}   create   [access code]
 *   PUT    /api/schedules/:id  {watchlist, budget, runAfter, enabled}    change   [access code]
 *   GET    /api/evidence                     evidence index (path, kind, verified)
 *   GET    /api/evidence/:track/:file        one evidence file
 *   GET    /api/approvals?status=&limit=     Human approval requests (D-066)
 *   POST   /api/approvals/:id  {decision}    approve or reject one payment   [access code]
 *   GET    /api/earnings                     sales of the agent's brief, from the Mirror Node (D-066)
 *   GET    /api/briefs/latest                the latest finished brief, as JSON (what the agent sells)
 *
 * Reads are public (the demo's evidence is meant to be seen) but rate limited.
 * Starting a task spends HBAR and 0G and needs the access code. Every
 * response is JSON (or markdown / SSE / an evidence file) with `nosniff`,
 * `no-store` and a deny-all CSP; errors are `{ error: CODE, message }` and
 * never echo secrets. Everything that holds text from outside (event payloads,
 * run errors, payment URLs, 0G errors, provider records, the brief) passes
 * through `redactText`/`redactValue` (D-053, D-060) on the way out. A POST,
 * PUT or DELETE that a browser marks as cross-site is refused (D-060).
 */
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { InferenceCall, PaymentIntent } from '@agent-economy/core/domain';
import { auditMessagesOf } from '../audit/auditor.ts';
import { getReport, getRun, listProviders, listRunEvents, listRuns } from '../db/repositories.ts';
import {
  APPROVAL_STATUSES,
  ApprovalError,
  type ApprovalStatus,
  type ApprovalStore,
  type PaymentApproval,
} from '../payments/approvals.ts';
import type { EarningsReading } from '../payments/earnings.ts';
import { MAX_VOICE_BYTES, voiceType, type VoiceService } from '../inference/transcribe.ts';
import { PaymentsPausedError } from '../orchestrator/orchestrator.ts';
import { WatchlistError, parseWatchlist } from '../orchestrator/watchlist.ts';
import {
  MAX_SCHEDULES,
  ScheduleError,
  formatRunAfter,
  parseRunAfter,
  type ScheduleInput,
  type ScheduleStore,
} from '../schedule/schedule-store.ts';
import { nextRunAt } from '../schedule/scheduler.ts';
import {
  PolicyConflictError,
  PolicyValidationError,
  capsView,
  parsePolicyUpdate,
  policyView,
  type PolicyStore,
} from '../policy/policy-store.ts';
import {
  SESSION_COOKIE,
  SessionStore,
  bearer,
  clearedCookie,
  codeMatches,
  parseCookies,
  sessionCookie,
  type CookieOptions,
} from './auth.ts';
import { ConnectionCounter, FixedWindowLimiter } from './limits.ts';
import { crossSiteRefused } from './origin.ts';
import { appCsp, byteRange, loadStaticSite } from './static.ts';
import { redactText, redactValue } from './redact.ts';
import { severityOf, stageOf, summarizeRun } from './run-summary.ts';
import { QueueFullError, type TaskRunner } from './task-runner.ts';

export interface ApiOptions {
  readonly db: DatabaseSync;
  readonly runner: TaskRunner;
  readonly payments: {
    listByRun(runId: string): Promise<PaymentIntent[]>;
    listRecent(limit: number): Promise<PaymentIntent[]>;
    committed(input: { runId: string; dayStart: string; dayEnd: string }): Promise<{ day: bigint }>;
  };
  /**
   * The latest Mirror Node reading of today's x402 spend this database does
   * not know about (D-062); already included in `payments.committed`.
   */
  readonly outsideSpend?: () => {
    readonly day: string;
    readonly tinybars: bigint;
    readonly count: number;
    readonly readAt: string;
  } | null;
  readonly inference: {
    listCalls(filter: { runId?: string; from?: string; to?: string }): Promise<InferenceCall[]>;
    spentOnDay(day: string): Promise<{ day: string; spent: bigint; calls: number }>;
  };
  /** Non-secret configuration shown to the UI (`GET /api/config`): networks, policy, caps. */
  readonly publicConfig: Readonly<Record<string, unknown>>;
  /** The owner's persisted policy under the env ceiling (D-052). */
  readonly policy: PolicyStore;
  /** Human approval requests (D-066); absent = the approval endpoints answer empty. */
  readonly approvals?: Pick<ApprovalStore, 'list' | 'listByRun' | 'decide'>;
  /** Sales of the agent's brief (D-066); null or absent = not for sale. */
  readonly earnings?: { readonly account: string; read(): Promise<EarningsReading> } | null;
  /**
   * The committed, verified Sepolia records (deployments/sepolia-erc8004.json
   * and deployments/sepolia-setups.json): ERC-8004 agent IDs and the ENSv2
   * subname setups shown with the providers (D-066). Null fields = not recorded.
   */
  readonly deployment?: () => Readonly<Record<string, unknown>> | null;
  /** Real networks, or the MOCK harness; shown on every page and stamped on run summaries. */
  readonly mode: 'live' | 'mock';
  /** Daily watchlist schedules (D-056). */
  readonly schedules: ScheduleStore;
  /**
   * The voice task (D-076): speech to text on 0G, ledgered. Null or absent =
   * voice input is off (`POST /api/voice` answers 503).
   */
  readonly voice?: Pick<VoiceService, 'transcribe' | 'linkProblem' | 'linkToRun'> | null;
  /** Evaluated right after a schedule is saved, so a due one starts without waiting a minute. */
  readonly scheduler?: { tick(): unknown };
  /** The scheduler's catch-up window in minutes (D-062); null = the whole day. */
  readonly catchUpWindowMin?: number | null;
  readonly accessCode: string;
  readonly hashscan: (transactionId: string) => string;
  readonly migration: number;
  /** Absolute path of docs/evidence. */
  readonly evidenceRoot: string;
  /**
   * The built web app served at / on the same origin (D-062), read into
   * memory at startup; absent = API only (development uses the Vite server).
   */
  readonly webRoot?: string;
  /** Frontend origin allowed by CORS (with credentials), or null. */
  readonly corsOrigin: string | null;
  /** Extra origins the page may fetch (the provider host it wakes, D-085); validated origins. */
  readonly connectOrigins?: readonly string[];
  /** Number of trusted reverse proxies in front (Render: 1); 0 = use the socket address. */
  readonly trustProxyHops: number;
  readonly secureCookies: boolean;
  readonly limits?: Partial<ApiLimits>;
  /** Where unexpected errors are reported, already redacted (D-060). The client only sees INTERNAL. */
  readonly logError?: (line: string) => void;
  readonly now?: () => number;
  /** SSE poll interval and heartbeat (tests shorten them). */
  readonly sse?: {
    readonly pollMs?: number;
    readonly heartbeatMs?: number;
    readonly maxMs?: number;
  };
}

export interface ApiLimits {
  readonly requestsPerMinute: number;
  readonly tasksPerHour: number;
  /** Voice transcriptions per client per hour (each is a paid 0G call, D-076). */
  readonly voicePerHour: number;
  readonly authFailuresPer15Min: number;
  readonly streamsPerClient: number;
  readonly streamsTotal: number;
}

export const DEFAULT_API_LIMITS: ApiLimits = {
  requestsPerMinute: 120,
  tasksPerHour: 5,
  voicePerHour: 20,
  authFailuresPer15Min: 10,
  streamsPerClient: 4,
  streamsTotal: 50,
};

const MAX_BODY = 16 * 1024;

/**
 * Responses are data, never documents: nothing may run, load or frame. Images
 * are allowed from this origin so an evidence PNG opened in a tab still shows
 * (D-060).
 */
export const API_CSP =
  "default-src 'none'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** A `limit` query parameter: an integer clamped to [1, max], or the default. Pure. */
export function limitParam(raw: string | null, fallback: number, max: number): number {
  if (raw === null || !/^\d{1,6}$/.test(raw)) return fallback;
  return Math.max(1, Math.min(Number(raw), max));
}

/**
 * The flags evidence files use for their overall result, in order. Older
 * files predate the uniform `verified` field. Deliberately explicit: a field
 * like `creditFundedInferenceVerified` is NOT a result flag (that run was
 * deposit-funded; the evidence test guards it).
 */
const RESULT_FLAGS = [
  'verified',
  'settledAndVerified',
  'schemaValidJsonVerified',
  'ledgerMatchesRouterUsage',
];
const resultOf = (d: Record<string, unknown>): boolean | null => {
  for (const flag of RESULT_FLAGS) if (typeof d[flag] === 'boolean') return d[flag];
  return null;
};
const utcDayBounds = (t: number) => {
  const day = new Date(t).toISOString().slice(0, 10);
  const start = `${day}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  return { day, start, end };
};
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TERMINAL = new Set(['RUN_FINISHED', 'RUN_FAILED']);

interface DiscoveryRow {
  readonly run_id: string;
  readonly payload: string;
  readonly at: string;
}

interface LogRow {
  readonly id: number;
  readonly run_id: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: string;
  readonly at: string;
}

type MaybeCount = { readonly n: number } | undefined;

const header = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  /** Every validation problem, for forms (`problems` in the error body). */
  readonly problems: readonly string[] | null;
  constructor(
    status: number,
    code: string,
    message: string,
    headers: Record<string, string> = {},
    problems: readonly string[] | null = null,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.problems = problems;
  }
}

/** JSON with bigints as strings. */
export const toJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

/** The client address: the socket, or the entry the last trusted proxy appended. Pure. */
export function clientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxyHops: number,
): string {
  const socket = socketAddress ?? 'unknown';
  if (trustProxyHops <= 0) return socket;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '');
  const chain = header
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return chain[chain.length - trustProxyHops] ?? socket;
}

export function createApi(o: ApiOptions) {
  const limits = { ...DEFAULT_API_LIMITS, ...o.limits };
  const now = o.now ?? Date.now;
  const requests = new FixedWindowLimiter(limits.requestsPerMinute, 60_000, now);
  const tasks = new FixedWindowLimiter(limits.tasksPerHour, 3600_000, now);
  const voices = new FixedWindowLimiter(limits.voicePerHour, 3600_000, now);
  const authFailures = new FixedWindowLimiter(limits.authFailuresPer15Min, 15 * 60_000, now);
  const streams = new ConnectionCounter(limits.streamsPerClient, limits.streamsTotal);
  const pageCsp = appCsp(o.connectOrigins ?? []);
  const sessions = new SessionStore(o.accessCode, 12 * 3600_000, 1000, now);
  const cookieOptions: CookieOptions = {
    secure: o.secureCookies,
    crossSite: o.corsOrigin !== null && o.corsOrigin.startsWith('https://'),
  };
  const evidenceRoot = resolve(o.evidenceRoot);
  const site = o.webRoot === undefined ? null : loadStaticSite(resolve(o.webRoot));
  const openStreams = new Set<() => void>();

  const baseHeaders = (req: IncomingMessage): Record<string, string> => {
    const h: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': API_CSP,
      'cross-origin-opener-policy': 'same-origin',
    };
    const origin = req.headers.origin;
    if (o.corsOrigin !== null && origin === o.corsOrigin) {
      h['access-control-allow-origin'] = origin;
      h['access-control-allow-credentials'] = 'true';
      h['vary'] = 'Origin';
    }
    return h;
  };

  const send = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ) => {
    const text = status === 204 ? '' : toJson(body);
    res.writeHead(status, {
      ...baseHeaders(req),
      ...(status === 204 ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      ...extra,
    });
    res.end(text);
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const type = req.headers['content-type'] ?? '';
    if (!/^application\/json(;|$)/i.test(type))
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send application/json');
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > MAX_BODY)
      throw new HttpError(413, 'BODY_TOO_LARGE', `at most ${MAX_BODY} bytes`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE', `at most ${MAX_BODY} bytes`);
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'the body is not JSON');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      throw new HttpError(400, 'INVALID_BODY', 'the body must be a JSON object');
    return body as Record<string, unknown>;
  };

  /** A raw audio body (the voice task): an accepted audio type, at most MAX_VOICE_BYTES. */
  const readAudio = async (req: IncomingMessage): Promise<{ type: string; bytes: Uint8Array }> => {
    const type = voiceType(req.headers['content-type']);
    if (type === null)
      throw new HttpError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'send audio/webm, audio/ogg, audio/mp4, audio/mpeg or audio/wav',
      );
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > MAX_VOICE_BYTES)
      throw new HttpError(413, 'BODY_TOO_LARGE', `at most ${MAX_VOICE_BYTES} bytes of audio`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_VOICE_BYTES)
        throw new HttpError(413, 'BODY_TOO_LARGE', `at most ${MAX_VOICE_BYTES} bytes of audio`);
      chunks.push(chunk as Buffer);
    }
    if (size === 0) throw new HttpError(400, 'EMPTY_AUDIO', 'the recording is empty');
    return { type, bytes: new Uint8Array(Buffer.concat(chunks)) };
  };

  const authorized = (req: IncomingMessage): boolean => {
    const code = bearer(req.headers.authorization);
    if (code !== null) return codeMatches(code, o.accessCode);
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    return token !== undefined && sessions.valid(token);
  };

  /** Access code check with a per-client failure limit (brute force). */
  const requireAccess = (req: IncomingMessage, client: string) => {
    const blocked = authFailures.peek(client);
    if (!blocked.allowed)
      throw new HttpError(429, 'TOO_MANY_AUTH_FAILURES', 'too many wrong access codes', {
        'retry-after': String(blocked.retryAfterSec),
      });
    if (!authorized(req)) {
      authFailures.take(client);
      throw new HttpError(401, 'ACCESS_DENIED', 'a valid access code is required');
    }
  };

  const safeRun = <T extends { error: string | null }>(run: T): T => ({
    ...run,
    error: run.error === null ? null : redactText(run.error),
  });
  const safeEvents = (events: ReturnType<typeof listRunEvents>) =>
    events.map((e) => ({ ...e, payload: redactValue(e.payload) }));
  /** A payment for the API: its request URL came from an ENS record (untrusted), so it is redacted. */
  const paymentView = (p: PaymentIntent) => ({
    ...p,
    requestUrl: redactText(p.requestUrl),
    hashscan: p.transactionId === null ? null : o.hashscan(p.transactionId),
  });
  /** A 0G ledger row for the API: its error code holds Router text, so it is redacted. */
  const callView = (c: InferenceCall) => ({
    ...c,
    errorCode: c.errorCode === null ? null : redactText(c.errorCode),
  });

  /** A run's HCS audit messages (D-057), with HashScan links for their transactions. */
  const auditOf = (runId: string) =>
    auditMessagesOf(o.db, runId).map((m) => ({
      kind: m.kind,
      paymentId: m.paymentId,
      topicId: m.topicId,
      status: m.status,
      sequenceNumber: m.sequenceNumber,
      consensusTimestamp: m.consensusTimestamp,
      transactionId: m.transactionId,
      hashscan: o.hashscan(m.transactionId),
      payloadSha256: m.payloadSha256,
      error: m.error === null ? null : redactText(m.error),
    }));

  /** An approval request for the API; its URL came from an ENS record, so it is redacted. */
  const approvalView = (a: PaymentApproval) => ({
    ...a,
    requestUrl: redactText(a.requestUrl),
    note: a.note === null ? null : redactText(a.note),
  });

  const taskDetail = async (id: string) => {
    const run = getRun(o.db, id);
    if (run === null) throw new HttpError(404, 'TASK_NOT_FOUND', 'no such task');
    const payments = await o.payments.listByRun(id);
    const events = listRunEvents(o.db, id);
    return {
      task: safeRun(run),
      summary: summarizeRun(events, run.status, o.mode),
      payments: payments.map(paymentView),
      inference: (await o.inference.listCalls({ runId: id })).map(callView),
      events: events.length,
      report: getReport(o.db, id) !== null,
      audit: auditOf(id),
      approvals: (o.approvals?.listByRun(id) ?? []).map(approvalView),
    };
  };

  const evidenceIndex = () => {
    const out: {
      path: string;
      track: string;
      kind: string;
      verified: boolean | null;
      bytes: number;
    }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        const st = lstatSync(p); // symlinks are skipped: nothing outside the folder is read
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(p);
        else if (/\.(json|png)$/.test(name)) {
          const rel = relative(evidenceRoot, p).split(sep).join('/');
          let kind = 'image';
          let verified: boolean | null = null;
          if (name.endsWith('.json')) {
            try {
              const d = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
              kind = typeof d['kind'] === 'string' ? d['kind'] : 'unknown';
              verified = resultOf(d);
            } catch {
              kind = 'unreadable';
            }
          }
          out.push({ path: rel, track: rel.split('/')[0] ?? '', kind, verified, bytes: st.size });
        }
      }
    };
    walk(evidenceRoot);
    return out;
  };

  const evidenceFile = (track: string, file: string): { body: Buffer; type: string } => {
    const p = resolve(evidenceRoot, track, file);
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      throw new HttpError(404, 'EVIDENCE_NOT_FOUND', 'no such evidence file');
    }
    if (!real.startsWith(`${realpathSync(evidenceRoot)}${sep}`))
      throw new HttpError(404, 'EVIDENCE_NOT_FOUND', 'no such evidence file');
    return {
      body: readFileSync(real),
      type: file.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8',
    };
  };

  const stream = (req: IncomingMessage, res: ServerResponse, id: string, client: string) => {
    if (getRun(o.db, id) === null) throw new HttpError(404, 'TASK_NOT_FOUND', 'no such task');
    const release = streams.acquire(client);
    if (release === null)
      throw new HttpError(429, 'TOO_MANY_STREAMS', 'too many open streams', {
        'retry-after': '10',
      });
    const url = new URL(req.url ?? '/', 'http://api');
    const fromHeader = Number(req.headers['last-event-id']);
    const fromQuery = Number(url.searchParams.get('after'));
    let cursor = Number.isInteger(fromHeader)
      ? fromHeader
      : Number.isInteger(fromQuery) && url.searchParams.has('after')
        ? fromQuery
        : -1;
    res.writeHead(200, {
      ...baseHeaders(req),
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const pollMs = o.sse?.pollMs ?? 500;
    const heartbeatMs = o.sse?.heartbeatMs ?? 15_000;
    const started = now();
    let lastWrite = now();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      openStreams.delete(close);
      release();
      res.end();
    };
    openStreams.add(close);
    const tick = () => {
      if (closed) return;
      for (const e of listRunEvents(o.db, id, cursor)) {
        res.write(
          `id: ${e.seq}\nevent: ${e.type}\ndata: ${toJson({ ...e, payload: redactValue(e.payload) })}\n\n`,
        );
        cursor = e.seq;
        lastWrite = now();
        if (TERMINAL.has(e.type)) {
          res.write(
            `event: end\ndata: ${toJson({ status: getRun(o.db, id)?.status ?? null })}\n\n`,
          );
          close();
          return;
        }
      }
      const run = getRun(o.db, id);
      if (run !== null && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) {
        res.write(`event: end\ndata: ${toJson({ status: run.status })}\n\n`);
        close();
        return;
      }
      if (now() - started > (o.sse?.maxMs ?? 30 * 60_000)) {
        close();
        return;
      }
      if (now() - lastWrite >= heartbeatMs) {
        res.write(': ping\n\n');
        lastWrite = now();
      }
    };
    const timer = setInterval(tick, pollMs);
    req.on('close', close);
    tick();
  };

  const scheduleView = (id: string) => {
    const s = o.schedules.get(id);
    if (s === null) throw new HttpError(404, 'SCHEDULE_NOT_FOUND', 'no such schedule');
    const nowDate = new Date(now());
    const today = nowDate.toISOString().slice(0, 10);
    const runs = o.schedules.runsOf(s.id).map((c) => {
      const run = getRun(o.db, c.runId);
      const events = run === null ? [] : listRunEvents(o.db, c.runId);
      const report = events.find((e) => e.type === 'REPORT_WRITTEN');
      return {
        day: c.day,
        runId: c.runId,
        status: run?.status ?? null,
        verdict: run === null ? null : summarizeRun(events, run.status, o.mode).verdict,
        delta: report === undefined ? null : redactValue(report.payload['delta'] ?? null),
      };
    });
    return {
      id: s.id,
      watchlist: s.watchlist,
      budget: s.budget.toString(),
      runAfter: formatRunAfter(s.runAfterMinute),
      enabled: s.enabled,
      lastSkip: s.lastSkip === null ? null : redactText(s.lastSkip),
      lastSkipAt: s.lastSkipAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      nextRunAt: nextRunAt(
        s,
        nowDate,
        runs.some((r) => r.day === today),
        o.catchUpWindowMin ?? null,
      ),
      runs,
    };
  };

  /** Validate a schedule body against the policy in force; every problem at once. */
  const scheduleInput = (body: Record<string, unknown>): ScheduleInput => {
    const allowed = ['watchlist', 'budget', 'runAfter', 'enabled'];
    const problems: string[] = [];
    const extra = Object.keys(body).filter((k) => !allowed.includes(k));
    if (extra.length > 0) problems.push(`unknown field(s): ${extra.join(', ')}`);
    let watchlist: string[] = [];
    try {
      const w = body['watchlist'];
      if (typeof w !== 'string' && !Array.isArray(w))
        throw new WatchlistError('watchlist must be a string or an array of strings');
      watchlist = parseWatchlist(w);
    } catch (error) {
      if (!(error instanceof WatchlistError)) throw error;
      problems.push(error.message);
    }
    const b = body['budget'];
    const max = o.policy.effective().policy.maxPerRun;
    let budget = 0n;
    if (typeof b !== 'string' || !/^[1-9]\d{0,15}$/.test(b))
      problems.push('budget must be a positive integer string (tinybars)');
    else if (BigInt(b) > max)
      problems.push(`budget ${b} is above the run budget in force (${max} tinybars)`);
    else budget = BigInt(b);
    const minute = parseRunAfter(body['runAfter']);
    if (minute === null) problems.push('runAfter must be a UTC time as HH:MM, e.g. 00:15');
    const enabled = body['enabled'] ?? true;
    if (typeof enabled !== 'boolean') problems.push('enabled must be true or false');
    if (problems.length > 0)
      throw new HttpError(400, 'SCHEDULE_INVALID', problems.join('; '), {}, problems);
    return { watchlist, budget, runAfterMinute: minute ?? 0, enabled: enabled as boolean };
  };

  const routes: {
    method: string;
    pattern: RegExp;
    handle: (
      req: IncomingMessage,
      res: ServerResponse,
      m: RegExpExecArray,
      client: string,
    ) => Promise<void> | void;
  }[] = [
    {
      method: 'GET',
      pattern: /^\/api\/health$/,
      handle: (req, res) =>
        send(req, res, 200, {
          status: 'ok',
          migration: o.migration,
          queue: o.runner.status(),
          // a payment waiting for the owner (D-066), for the status bar
          approvals: { pending: o.approvals?.list({ status: 'PENDING', limit: 100 }).length ?? 0 },
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/session$/,
      handle: async (req, res, _m, client) => {
        const blocked = authFailures.peek(client);
        if (!blocked.allowed)
          throw new HttpError(429, 'TOO_MANY_AUTH_FAILURES', 'too many wrong access codes', {
            'retry-after': String(blocked.retryAfterSec),
          });
        const body = await readJson(req);
        if (typeof body['code'] !== 'string' || !codeMatches(body['code'], o.accessCode)) {
          authFailures.take(client);
          throw new HttpError(401, 'ACCESS_DENIED', 'wrong access code');
        }
        const s = sessions.create();
        send(req, res, 204, null, {
          'set-cookie': sessionCookie(s.token, s.maxAgeSec, cookieOptions),
        });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/session$/,
      handle: (req, res) => {
        const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
        if (token !== undefined) sessions.revoke(token);
        send(req, res, 204, null, { 'set-cookie': clearedCookie(cookieOptions) });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/session$/,
      handle: (req, res) => send(req, res, 200, { authenticated: authorized(req) }),
    },
    {
      method: 'GET',
      pattern: /^\/api\/config$/,
      handle: (req, res) => {
        // the policy shown is the one the firewall enforces now, not the env file
        const e = o.policy.effective();
        const base = (o.publicConfig['policy'] ?? {}) as Record<string, unknown>;
        send(req, res, 200, {
          ...o.publicConfig,
          mode: o.mode,
          policy: {
            ...base,
            maxPerPayment: e.policy.maxPerPayment.toString(),
            maxPerRun: e.policy.maxPerRun.toString(),
            maxPerDay: e.policy.maxPerDay.toString(),
            maxPaymentsPerRun: e.policy.maxPaymentsPerRun,
            paymentsPaused: e.policy.paymentsPaused === true,
            approvalMode: e.approval.mode,
            approvalAboveTinybars: e.approval.aboveTinybars.toString(),
            providerDailyCaps: capsView(e.policy.providerDailyCaps ?? {}),
            source: e.source,
            version: e.version,
          },
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/policy$/,
      handle: (req, res) => send(req, res, 200, policyView(o.policy)),
    },
    {
      method: 'PUT',
      pattern: /^\/api\/policy$/,
      handle: async (req, res, _m, client) => {
        requireAccess(req, client);
        // the approval and per-provider fields carry over when a client leaves them out (D-066)
        const parsed = parsePolicyUpdate(await readJson(req), o.policy.ceiling, o.policy.latest());
        if (!parsed.ok)
          throw new HttpError(
            400,
            'POLICY_INVALID',
            parsed.problems.join('; '),
            {},
            parsed.problems,
          );
        try {
          o.policy.save(parsed.update);
        } catch (error) {
          if (error instanceof PolicyConflictError)
            throw new HttpError(409, 'POLICY_CONFLICT', error.message);
          if (error instanceof PolicyValidationError)
            throw new HttpError(
              400,
              'POLICY_INVALID',
              error.problems.join('; '),
              {},
              error.problems,
            );
          throw error;
        }
        send(req, res, 200, policyView(o.policy));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/providers$/,
      handle: (req, res) => {
        // the ENS proof: the block and time of the latest discovery
        const row = o.db
          .prepare(
            "SELECT run_id, payload, at FROM run_events WHERE type = 'PROVIDERS_DISCOVERED' ORDER BY at DESC, rowid DESC LIMIT 1",
          )
          .get() as DiscoveryRow | undefined;
        const p = row === undefined ? null : (JSON.parse(row.payload) as Record<string, unknown>);
        const deployment = o.deployment?.() ?? null;
        send(req, res, 200, {
          // endpoints and records came from ENS: untrusted, redacted like any outside text
          providers: redactValue(listProviders(o.db)),
          // from the committed, verified deployment record, not from this run (D-066)
          identity: deployment === null ? null : (deployment['erc8004'] ?? null),
          ensSetups: deployment === null ? null : (deployment['setups'] ?? null),
          snapshot:
            row === undefined || p === null
              ? null
              : {
                  runId: row.run_id,
                  parent: p['parent'] ?? null,
                  blockNumber: p['blockNumber'] ?? null,
                  observedAt: p['observedAt'] ?? row.at,
                },
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/payments$/,
      handle: async (req, res) => {
        const limit = limitParam(
          new URL(req.url ?? '/', 'http://api').searchParams.get('limit'),
          50,
          200,
        );
        const today = utcDayBounds(now());
        const payments = await o.payments.listRecent(limit);
        const committed = await o.payments.committed({
          runId: '-',
          dayStart: today.start,
          dayEnd: today.end,
        });
        send(req, res, 200, {
          payments: payments.map(paymentView),
          today: {
            day: today.day,
            committedAtomic: committed.day,
            outside: (() => {
              const r = o.outsideSpend?.() ?? null;
              return r === null || r.day !== today.day
                ? null
                : { atomic: r.tinybars, count: r.count, readAt: r.readAt };
            })(),
          },
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/inference$/,
      handle: async (req, res) => {
        const n = limitParam(
          new URL(req.url ?? '/', 'http://api').searchParams.get('limit'),
          50,
          200,
        );
        const today = utcDayBounds(now());
        const calls = (await o.inference.listCalls({})).slice(-n).reverse().map(callView);
        const spent = await o.inference.spentOnDay(today.day);
        send(req, res, 200, {
          calls,
          today: { day: spent.day, spentNeuron: spent.spent, calls: spent.calls },
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/tasks$/,
      handle: (req, res) => {
        const limit = limitParam(
          new URL(req.url ?? '/', 'http://api').searchParams.get('limit'),
          20,
          100,
        );
        send(req, res, 200, {
          tasks: listRuns(o.db, limit).map(safeRun),
          queue: o.runner.status(),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/runs$/,
      handle: async (req, res) => {
        const limit = Number(
          new URL(req.url ?? '/', 'http://api').searchParams.get('limit') ?? '20',
        );
        const n = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 50)) : 20;
        const runs = await Promise.all(
          listRuns(o.db, n).map(async (run) => {
            const events = listRunEvents(o.db, run.id);
            const payments = await o.payments.listByRun(run.id);
            const calls = await o.inference.listCalls({ runId: run.id });
            return {
              task: safeRun(run),
              summary: summarizeRun(events, run.status, o.mode),
              events: events.length,
              payments: payments.map((p) => ({
                id: p.id,
                provider: p.provider,
                amountAtomic: p.amountAtomic,
                status: p.status,
                refusalCode: p.refusalCode,
                transactionId: p.transactionId,
                hashscan: p.transactionId === null ? null : o.hashscan(p.transactionId),
              })),
              inference: calls.map((c) => ({
                id: c.id,
                purpose: c.purpose,
                status: c.status,
                requestId: c.requestId,
                costNeuron: c.costNeuron,
                funding: c.funding,
                teeVerified: c.teeVerified,
              })),
              audit: auditOf(run.id),
            };
          }),
        );
        send(req, res, 200, { mode: o.mode, runs });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/logs$/,
      handle: (req, res) => {
        const q = new URL(req.url ?? '/', 'http://api').searchParams;
        const limit = Number(q.get('limit') ?? '10');
        const n = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 10;
        const cursor = (name: string): number | null => {
          if (!q.has(name)) return null;
          const v = Number(q.get(name));
          if (!Number.isInteger(v) || v < 0)
            throw new HttpError(400, 'INVALID_CURSOR', `${name} must be a non-negative integer`);
          return v;
        };
        // before: older entries (paging); after: newer entries (live updates)
        const before = cursor('before');
        const after = cursor('after');
        // rowid is the insertion order across runs (run_events is append-only)
        const rows = o.db
          .prepare(
            'SELECT rowid AS id, run_id, seq, type, payload, at FROM run_events WHERE rowid < ? AND rowid > ? ORDER BY rowid DESC LIMIT ?',
          )
          .all(before ?? Number.MAX_SAFE_INTEGER, after ?? -1, n + 1) as unknown as LogRow[];
        const page = rows.slice(0, n);
        const total = o.db.prepare('SELECT COUNT(*) AS n FROM run_events').get() as MaybeCount;
        send(req, res, 200, {
          entries: page.map((r) => {
            const payload = JSON.parse(r.payload) as Record<string, unknown>;
            const e = { type: r.type, payload };
            return {
              id: r.id,
              runId: r.run_id,
              seq: r.seq,
              type: r.type,
              stage: stageOf(e),
              severity: severityOf(e),
              at: r.at,
              payload: redactValue(payload),
            };
          }),
          next: rows.length > n ? (page.at(-1)?.id ?? null) : null,
          total: total?.n ?? 0,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/tasks$/,
      handle: async (req, res, _m, client) => {
        requireAccess(req, client);
        const body = await readJson(req);
        const extra = Object.keys(body).filter(
          (k) => k !== 'watchlist' && k !== 'budget' && k !== 'voiceCallId',
        );
        if (extra.length > 0)
          throw new HttpError(400, 'UNKNOWN_FIELD', `unknown field(s): ${extra.join(', ')}`);
        let watchlist: string[];
        try {
          const w = body['watchlist'];
          if (typeof w !== 'string' && !Array.isArray(w))
            throw new WatchlistError('watchlist must be a string or an array of strings');
          watchlist = parseWatchlist(w);
        } catch (error) {
          if (error instanceof WatchlistError)
            throw new HttpError(400, 'INVALID_WATCHLIST', error.message);
          throw error;
        }
        const b = body['budget'];
        if (b !== undefined && (typeof b !== 'string' || !/^[1-9]\d{0,15}$/.test(b)))
          throw new HttpError(
            400,
            'INVALID_BUDGET',
            'budget must be a positive integer string (tinybars)',
          );
        // a spoken watchlist (D-076): the 0G transcription that produced it joins the run
        const v = body['voiceCallId'];
        if (v !== undefined) {
          if (typeof v !== 'string' || !new RegExp(`^${UUID}$`).test(v))
            throw new HttpError(400, 'INVALID_VOICE_CALL', 'voiceCallId must be a UUID');
          if (o.voice === null || o.voice === undefined)
            throw new HttpError(400, 'INVALID_VOICE_CALL', 'voice input is off');
          const problem = await o.voice.linkProblem(v);
          if (problem !== null) throw new HttpError(400, 'INVALID_VOICE_CALL', problem);
        }
        const quota = tasks.peek(client);
        if (!quota.allowed)
          throw new HttpError(429, 'TOO_MANY_TASKS', 'task limit reached for this hour', {
            'retry-after': String(quota.retryAfterSec),
          });
        let submitted: ReturnType<TaskRunner['submit']>;
        try {
          submitted = o.runner.submit(
            { trigger: 'manual', watchlist },
            b === undefined ? undefined : BigInt(b),
          );
        } catch (error) {
          if (error instanceof PaymentsPausedError)
            throw new HttpError(409, 'PAYMENTS_PAUSED', error.message);
          if (error instanceof RangeError)
            throw new HttpError(400, 'INVALID_BUDGET', error.message);
          if (error instanceof QueueFullError)
            throw new HttpError(503, 'QUEUE_FULL', error.message, { 'retry-after': '60' });
          throw error;
        }
        tasks.take(client);
        const voiceLinked =
          typeof v === 'string' && o.voice !== null && o.voice !== undefined
            ? await o.voice.linkToRun(v, submitted.run.id)
            : false;
        send(req, res, 202, {
          ...(typeof v === 'string' ? { voiceLinked } : {}),
          task: submitted.run,
          position: submitted.position,
          stream: `/api/tasks/${submitted.run.id}/stream`,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/voice$/,
      handle: async (req, res, _m, client) => {
        requireAccess(req, client);
        if (o.voice === null || o.voice === undefined)
          throw new HttpError(503, 'VOICE_OFF', 'voice input is off on this server');
        const quota = voices.peek(client);
        if (!quota.allowed)
          throw new HttpError(429, 'TOO_MANY_TRANSCRIPTIONS', 'voice limit reached for this hour', {
            'retry-after': String(quota.retryAfterSec),
          });
        const audio = await readAudio(req);
        voices.take(client);
        const outcome = await o.voice.transcribe(audio.bytes, audio.type);
        if (outcome.kind === 'transcribed') {
          send(req, res, 200, { text: outcome.text, call: callView(outcome.call) });
          return;
        }
        // the 0G call and its ledger row are shown either way: nothing is hidden
        send(req, res, outcome.kind === 'refused' ? 409 : 502, {
          error: outcome.kind === 'refused' ? 'TRANSCRIPTION_REFUSED' : 'TRANSCRIPTION_FAILED',
          message: redactText(`${outcome.code}: ${outcome.reason}`),
          call: callView(outcome.call),
        });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/api/tasks/(${UUID})$`),
      handle: async (req, res, m) => send(req, res, 200, await taskDetail(m[1] ?? '')),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/api/tasks/(${UUID})/events$`),
      handle: (req, res, m) => {
        const id = m[1] ?? '';
        if (getRun(o.db, id) === null) throw new HttpError(404, 'TASK_NOT_FOUND', 'no such task');
        const after = Number(
          new URL(req.url ?? '/', 'http://api').searchParams.get('after') ?? '-1',
        );
        send(req, res, 200, {
          events: safeEvents(listRunEvents(o.db, id, Number.isInteger(after) ? after : -1)),
        });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/api/tasks/(${UUID})/stream$`),
      handle: (req, res, m, client) => stream(req, res, m[1] ?? '', client),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/api/tasks/(${UUID})/report$`),
      handle: (req, res, m) => {
        const r = getReport(o.db, m[1] ?? '');
        if (r === null)
          throw new HttpError(404, 'REPORT_NOT_FOUND', 'no brief for this task (yet)');
        res.writeHead(200, { ...baseHeaders(req), 'content-type': 'text/markdown; charset=utf-8' });
        // the brief quotes provider data and model output: redacted like every other outside text
        res.end(redactText(r.markdown));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/approvals$/,
      handle: (req, res) => {
        const q = new URL(req.url ?? '/', 'http://api').searchParams;
        const status = q.get('status');
        if (status !== null && !(APPROVAL_STATUSES as readonly string[]).includes(status))
          throw new HttpError(
            400,
            'INVALID_STATUS',
            `status must be one of ${APPROVAL_STATUSES.join(', ')}`,
          );
        const limit = limitParam(q.get('limit'), 20, 100);
        const list =
          o.approvals?.list({
            ...(status === null ? {} : { status: status as ApprovalStatus }),
            limit,
          }) ?? [];
        const e = o.policy.effective();
        send(req, res, 200, {
          mode: e.approval.mode,
          aboveTinybars: e.approval.aboveTinybars.toString(),
          approvals: list.map(approvalView),
        });
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/api/approvals/(${UUID})$`),
      handle: async (req, res, m, client) => {
        requireAccess(req, client);
        const body = await readJson(req);
        const extra = Object.keys(body).filter((k) => k !== 'decision' && k !== 'note');
        if (extra.length > 0)
          throw new HttpError(400, 'UNKNOWN_FIELD', `unknown field(s): ${extra.join(', ')}`);
        const d = body['decision'];
        if (d !== 'approve' && d !== 'reject')
          throw new HttpError(400, 'INVALID_DECISION', 'decision must be "approve" or "reject"');
        const note = body['note'];
        if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 200))
          throw new HttpError(400, 'INVALID_NOTE', 'note must be text of at most 200 characters');
        if (o.approvals === undefined)
          throw new HttpError(404, 'APPROVAL_NOT_FOUND', 'no such approval request');
        try {
          const a = o.approvals.decide(
            m[1] ?? '',
            d === 'approve' ? 'APPROVED' : 'REJECTED',
            typeof note === 'string' ? note : null,
          );
          send(req, res, 200, { approval: approvalView(a) });
        } catch (error) {
          if (error instanceof ApprovalError) {
            if (error.code === 'NOT_FOUND')
              throw new HttpError(404, 'APPROVAL_NOT_FOUND', error.message);
            if (error.code === 'EXPIRED')
              throw new HttpError(410, 'APPROVAL_EXPIRED', error.message);
            throw new HttpError(409, 'APPROVAL_ALREADY_DECIDED', error.message);
          }
          throw error;
        }
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/earnings$/,
      handle: async (req, res) => {
        const e = o.earnings ?? null;
        if (e === null) {
          send(req, res, 200, { enabled: false, account: null });
          return;
        }
        let r: EarningsReading;
        try {
          r = await e.read();
        } catch {
          // fixed message: the Mirror Node's own error text is not echoed
          throw new HttpError(
            503,
            'EARNINGS_UNAVAILABLE',
            'the Hedera Mirror Node could not be read; try again shortly',
          );
        }
        send(req, res, 200, {
          enabled: true,
          account: r.account,
          windowDays: Math.round((r.toSeconds - r.fromSeconds) / 86_400),
          tinybars: r.tinybars,
          outsideTinybars: r.outsideTinybars,
          sales: r.sales
            .slice(-50)
            .reverse()
            .map((x) => ({
              ...x,
              hashscan: o.hashscan(x.transactionId),
            })),
          readAt: r.readAt,
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/briefs\/latest$/,
      handle: (req, res) => {
        // the newest finished task with a brief: what the agent sells (D-066)
        const row = o.db
          .prepare(
            `SELECT r.id AS id FROM runs r JOIN reports p ON p.run_id = r.id
             WHERE r.status = 'SUCCEEDED' ORDER BY r.finished_at DESC, r.rowid DESC LIMIT 1`,
          )
          .get() as { id: string } | undefined;
        if (row === undefined) throw new HttpError(404, 'NO_BRIEF', 'no finished brief yet');
        const run = getRun(o.db, row.id);
        const report = getReport(o.db, row.id);
        if (run === null || report === null)
          throw new HttpError(404, 'NO_BRIEF', 'no finished brief yet');
        const events = listRunEvents(o.db, row.id);
        const analysis = events.find((x) => x.type === 'ANALYSIS_COMPLETED')?.payload ?? null;
        const summary = summarizeRun(events, run.status, o.mode);
        send(req, res, 200, {
          runId: run.id,
          watchlist: run.watchlist,
          finishedAt: run.finishedAt,
          environment: summary.environment,
          verdict: summary.verdict,
          digest: analysis === null ? null : redactValue(analysis['digest'] ?? null),
          // the brief quotes provider data and model output: redacted like every outside text
          markdown: redactText(report.markdown),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/schedules$/,
      handle: (req, res) =>
        send(req, res, 200, {
          now: new Date(now()).toISOString(),
          max: MAX_SCHEDULES,
          schedules: o.schedules.list().map((s) => scheduleView(s.id)),
        }),
    },
    {
      method: 'POST',
      pattern: /^\/api\/schedules$/,
      handle: async (req, res, _m, client) => {
        requireAccess(req, client);
        const input = scheduleInput(await readJson(req));
        let id: string;
        try {
          id = o.schedules.create(input).id;
        } catch (error) {
          if (error instanceof ScheduleError) throw new HttpError(409, error.code, error.message);
          throw error;
        }
        o.scheduler?.tick();
        send(req, res, 201, scheduleView(id));
      },
    },
    {
      method: 'PUT',
      pattern: new RegExp(`^/api/schedules/(${UUID})$`),
      handle: async (req, res, m, client) => {
        requireAccess(req, client);
        const id = m[1] ?? '';
        if (o.schedules.get(id) === null)
          throw new HttpError(404, 'SCHEDULE_NOT_FOUND', 'no such schedule');
        o.schedules.update(id, scheduleInput(await readJson(req)));
        o.scheduler?.tick();
        send(req, res, 200, scheduleView(id));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/evidence$/,
      handle: (req, res) => send(req, res, 200, { files: evidenceIndex() }),
    },
    {
      method: 'GET',
      pattern:
        /^\/api\/evidence\/([a-z0-9-]{1,40})\/([A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(?:json|png))$/,
      handle: (req, res, m) => {
        const f = evidenceFile(m[1] ?? '', m[2] ?? '');
        res.writeHead(200, { ...baseHeaders(req), 'content-type': f.type });
        res.end(f.body);
      },
    },
  ];

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const client = clientAddress(
      req.socket.remoteAddress,
      req.headers['x-forwarded-for'],
      o.trustProxyHops,
    );
    try {
      const path = new URL(req.url ?? '/', 'http://api').pathname;
      // the web app (D-062): GET or HEAD outside /api, answered from memory
      if (
        site !== null &&
        (req.method === 'GET' || req.method === 'HEAD') &&
        path !== '/api' &&
        !path.startsWith('/api/')
      ) {
        const file = site.get(path);
        if (file === undefined) {
          res.writeHead(404, {
            ...baseHeaders(req),
            'content-type': 'text/plain; charset=utf-8',
            'content-security-policy': API_CSP,
          });
          res.end(req.method === 'HEAD' ? undefined : 'not found');
          return;
        }
        const size = file.body.length;
        const headers = {
          ...baseHeaders(req),
          'content-type': file.type,
          'cache-control': file.cacheControl,
          'content-security-policy': pageCsp,
          'accept-ranges': 'bytes',
        };
        // a byte range, so audio can seek to a track's start position (D-074)
        const range = byteRange(header(req.headers.range), size);
        if (range === 'unsatisfiable') {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
          res.end();
          return;
        }
        if (range !== null) {
          const part = file.body.subarray(range.start, range.end + 1);
          res.writeHead(206, {
            ...headers,
            'content-range': `bytes ${range.start}-${range.end}/${size}`,
            'content-length': String(part.length),
          });
          res.end(req.method === 'HEAD' ? undefined : part);
          return;
        }
        res.writeHead(200, { ...headers, 'content-length': String(size) });
        res.end(req.method === 'HEAD' ? undefined : file.body);
        return;
      }
      if (req.method === 'OPTIONS') {
        if (o.corsOrigin === null || req.headers.origin !== o.corsOrigin)
          throw new HttpError(403, 'CORS_ORIGIN_NOT_ALLOWED', 'origin not allowed');
        res.writeHead(204, {
          ...baseHeaders(req),
          'access-control-allow-methods': 'GET, POST, PUT, DELETE',
          'access-control-allow-headers': 'content-type, authorization, last-event-id',
          'access-control-max-age': '600',
        });
        res.end();
        return;
      }
      if (
        crossSiteRefused({
          method: req.method,
          origin: req.headers.origin,
          secFetchSite: header(req.headers['sec-fetch-site']),
          host: req.headers.host,
          corsOrigin: o.corsOrigin,
        })
      )
        throw new HttpError(403, 'CROSS_SITE_REFUSED', 'cross-site writes are refused');
      const decision = requests.take(client);
      if (!decision.allowed)
        throw new HttpError(429, 'RATE_LIMITED', 'too many requests', {
          'retry-after': String(decision.retryAfterSec),
        });
      const candidates = routes.filter((r) => r.pattern.test(path));
      if (candidates.length === 0) throw new HttpError(404, 'NOT_FOUND', 'no such endpoint');
      const route = candidates.find((r) => r.method === req.method);
      if (route === undefined)
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'method not allowed', {
          allow: candidates.map((r) => r.method).join(', '),
        });
      const m = route.pattern.exec(path);
      if (m === null) throw new HttpError(404, 'NOT_FOUND', 'no such endpoint');
      await route.handle(req, res, m, client);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError)
        send(
          req,
          res,
          error.status,
          {
            error: error.code,
            message: error.message,
            ...(error.problems === null ? {} : { problems: error.problems }),
          },
          error.headers,
        );
      else {
        o.logError?.(
          redactText(
            `API ${req.method ?? '?'} ${(req.url ?? '/').split('?')[0]}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        send(req, res, 500, { error: 'INTERNAL', message: 'internal error' });
      }
    }
  };

  return {
    handler,
    /** End every open event stream (shutdown, tests). */
    closeStreams: () => {
      for (const close of [...openStreams]) close();
    },
    openStreams: () => streams.open,
  };
}
