/**
 * The agent's brief for sale (D-066): how the agent earns.
 *
 * `/v1/agent/brief` is an x402 route of this service, paid in HBAR to the
 * agent's own earnings account (AGENT_EARNINGS_ACCOUNT). Its data is the
 * agent's latest finished brief, read from the agent's public API
 * (`GET <AGENT_PUBLIC_URL>/api/briefs/latest`) at request time. The payer is
 * charged only when that read succeeds and the brief passes the schema below:
 * like every route here, an upstream failure answers >= 400, and @x402/hono
 * settles only below 400.
 *
 * The same brief is readable in the agent's web app; this route is the
 * machine interface other agents pay for. It never claims anything the agent
 * did not record: the run ID, its verdict and environment come from the agent.
 */
import { createGuardedFetch } from '@agent-economy/net-guard';
import { UpstreamError } from './feeds/http.ts';

/** What the agent's /api/briefs/latest answers (only these fields are passed on). */
export interface AgentBrief {
  readonly runId: string;
  readonly watchlist: readonly string[];
  readonly finishedAt: string | null;
  readonly environment: 'live' | 'mock';
  readonly verdict: string;
  readonly digest: unknown;
  readonly markdown: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Check the agent's answer field by field; null when it is not a brief. Pure. */
export function parseAgentBrief(body: unknown): AgentBrief | null {
  if (!isRecord(body)) return null;
  const { runId, watchlist, finishedAt, environment, verdict, digest, markdown } = body;
  if (typeof runId !== 'string' || !UUID.test(runId)) return null;
  if (
    !Array.isArray(watchlist) ||
    watchlist.length > 50 ||
    !watchlist.every((w) => typeof w === 'string' && w.length <= 200)
  )
    return null;
  if (finishedAt !== null && (typeof finishedAt !== 'string' || finishedAt.length > 40))
    return null;
  if (environment !== 'live' && environment !== 'mock') return null;
  if (typeof verdict !== 'string' || verdict.length > 40) return null;
  if (typeof markdown !== 'string' || markdown.length > 200_000) return null;
  return {
    runId,
    watchlist: watchlist as string[],
    finishedAt: finishedAt as string | null,
    environment: environment as 'live' | 'mock',
    verdict,
    digest: digest ?? null,
    markdown,
  };
}

export interface BriefSale {
  readonly priceTinybars: bigint;
  /** The agent's earnings account: the payee of every sale. */
  readonly payTo: string;
  /** Read the latest brief; throws UpstreamError when it cannot. */
  readonly read: () => Promise<AgentBrief>;
}

export class NoBriefError extends Error {
  constructor() {
    super('the agent has no finished brief yet; not charged');
    this.name = 'NoBriefError';
  }
}

/**
 * A reader for `<agentUrl>/api/briefs/latest`, through the net-guard (every
 * resolved address public, pinned, no redirects, size and time caps).
 * http is allowed only for a loopback agent outside production.
 */
export function briefReader(options: {
  readonly agentUrl: string;
  readonly production: boolean;
  readonly fetch?: typeof globalThis.fetch;
}): () => Promise<AgentBrief> {
  const base = options.agentUrl.replace(/\/+$/, '');
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(base);
  if (!base.startsWith('https://') && !(loopback && !options.production))
    throw new Error('AGENT_PUBLIC_URL must be https (http only for a local agent in development)');
  const doFetch =
    options.fetch ??
    createGuardedFetch({ allowLoopbackHttp: loopback, maxBytes: 512 * 1024, timeoutMs: 20_000 });
  return async () => {
    let res: Response;
    try {
      res = await doFetch(`${base}/api/briefs/latest`, {
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      const timeout =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new UpstreamError(
        timeout ? 'the agent timed out' : 'the agent is unreachable',
        timeout ? 504 : 502,
      );
    }
    if (res.status === 404) throw new NoBriefError();
    if (!res.ok) throw new UpstreamError(`the agent answered HTTP ${res.status}`, 502);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new UpstreamError('the agent sent invalid JSON', 502);
    }
    const brief = parseAgentBrief(body);
    if (brief === null) throw new UpstreamError('the agent sent an unexpected brief', 502);
    return brief;
  };
}
