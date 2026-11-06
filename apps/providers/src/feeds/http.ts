/**
 * Fetching from the public feeds. Upstream hosts are fixed constants (never
 * request-controlled), but their responses are untrusted: https only, no
 * redirects, a hard timeout and a byte cap, JSON parsed only after the cap.
 * By default the request goes through the net-guard (D-045): every resolved
 * address must be public and the connection is pinned to it.
 */
import { createGuardedFetch } from '@agent-economy/net-guard';

export class UpstreamError extends Error {
  /** HTTP status the provider should answer with (no settlement happens for >= 400). */
  readonly status: 502 | 503 | 504;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, status: 502 | 503 | 504, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface FetchJsonOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Injected in tests; defaults to the net-guard's pinned, SSRF-safe fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  if (!url.startsWith('https://')) throw new UpstreamError('upstream URL must be https', 502);
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const doFetch =
    options.fetch ?? createGuardedFetch({ maxBytes, timeoutMs: options.timeoutMs ?? 20_000 });
  let res: Response;
  try {
    res = await doFetch(url, {
      method: options.method ?? 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      headers: {
        accept: 'application/json',
        'user-agent': 'endersift/0.1 (threat-intel provider)',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    const timeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new UpstreamError(
      timeout ? 'upstream timed out' : 'upstream unreachable',
      timeout ? 504 : 502,
    );
  }
  if (res.status === 429 || res.status === 503) {
    const retry = Number(res.headers.get('retry-after'));
    throw new UpstreamError(
      `upstream is rate limiting (HTTP ${res.status})`,
      503,
      Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) : 30,
    );
  }
  if (!res.ok) throw new UpstreamError(`upstream answered HTTP ${res.status}`, 502);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UpstreamError('upstream response too large', 502);
  }
  const reader = res.body?.getReader();
  if (reader === undefined) throw new UpstreamError('upstream sent no body', 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new UpstreamError('upstream response too large', 502);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new UpstreamError('upstream sent invalid JSON', 502);
  }
}

/** A small TTL cache; one in-flight fetch per key (concurrent callers share it). */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(ttlMs: number, maxEntries = 500, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  async get(key: string, load: () => Promise<T>): Promise<{ value: T; fetchedAt: number }> {
    const hit = this.entries.get(key);
    if (hit !== undefined && this.now() - hit.at < this.ttlMs)
      return { value: hit.value, fetchedAt: hit.at };
    let pending = this.inflight.get(key);
    if (pending === undefined) {
      pending = load().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const value = await pending;
    const at = this.now();
    this.entries.set(key, { value, at });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return { value, fetchedAt: at };
  }
}

/** Requests per rolling window (NVD: 5 per 30 s without a key, 50 with one). */
export class RollingLimiter {
  private readonly stamps: number[] = [];

  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Milliseconds until a slot is free (0 = now). Reserves the slot when it returns 0. */
  tryAcquire(): number {
    const t = this.now();
    while (this.stamps.length > 0 && t - (this.stamps[0] ?? 0) >= this.windowMs)
      this.stamps.shift();
    if (this.stamps.length < this.limit) {
      this.stamps.push(t);
      return 0;
    }
    return this.windowMs - (t - (this.stamps[0] ?? 0));
  }
}
