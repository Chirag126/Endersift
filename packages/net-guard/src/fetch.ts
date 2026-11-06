/**
 * The pinned transport (node:https / node:http with a custom `lookup` that
 * always answers the checked address) and a fetch-compatible wrapper.
 */
import type { LookupFunction } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  NetGuardError,
  checkTarget,
  systemResolver,
  type CheckedTarget,
  type NetGuardPolicy,
  type Resolver,
} from './guard.ts';

export interface TransportRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface TransportLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | null;
}

export type Transport = (
  target: CheckedTarget,
  req: TransportRequest,
  limits: TransportLimits,
) => Promise<TransportResponse>;

const flatHeaders = (res: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
};

/**
 * Connects to `target.pinned` whatever the name resolves to now: the lookup
 * never consults DNS. TLS still verifies the certificate for the hostname
 * (SNI and Host are the hostname), so pinning cannot be used to impersonate.
 */
export const nodeTransport: Transport = (target, req, limits) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      const cb = callback as (err: Error | null, address: unknown, family?: number) => void;
      if ((options as { all?: boolean }).all === true)
        cb(null, [{ address: target.pinned.address, family: target.pinned.family }]);
      else cb(null, target.pinned.address, target.pinned.family);
    };
    const isHttps = target.url.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      r.destroy();
      reject(e);
    };
    const timer = setTimeout(
      () =>
        fail(new NetGuardError('TIMEOUT', `no complete response within ${limits.timeoutMs} ms`)),
      limits.timeoutMs,
    );
    const r = send(
      target.url,
      {
        method: req.method,
        headers: {
          ...req.headers,
          ...(req.body === null ? {} : { 'content-length': String(req.body.byteLength) }),
        },
        lookup: pinnedLookup,
        ...(isHttps && target.url.hostname !== target.pinned.address
          ? { servername: target.hostname }
          : {}),
        agent: false,
      },
      (res) => {
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > limits.maxBytes) {
          fail(
            new NetGuardError(
              'RESPONSE_TOO_LARGE',
              `Content-Length ${declared} > ${limits.maxBytes}`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > limits.maxBytes) {
            fail(new NetGuardError('RESPONSE_TOO_LARGE', `more than ${limits.maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            status: res.statusCode ?? 0,
            headers: flatHeaders(res),
            body: new Uint8Array(Buffer.concat(chunks)),
          });
        });
        res.on('error', (e) => fail(new NetGuardError('CONNECTION_FAILED', e.message)));
      },
    );
    r.on('error', (e) =>
      fail(e instanceof NetGuardError ? e : new NetGuardError('CONNECTION_FAILED', e.message)),
    );
    limits.signal?.addEventListener(
      'abort',
      () => fail(new NetGuardError('TIMEOUT', 'aborted by the caller')),
      { once: true },
    );
    if (req.body !== null) r.write(req.body);
    r.end();
  });

export interface GuardedFetchDeps {
  readonly resolve?: Resolver;
  readonly transport?: Transport;
}

export interface GuardedResponse extends TransportResponse {
  readonly target: CheckedTarget;
}

/** One guarded request: check (URL, DNS, every address), pin, no redirects, caps. */
export async function guardedRequest(
  url: string,
  req: Partial<TransportRequest> = {},
  policy: NetGuardPolicy = {},
  deps: GuardedFetchDeps = {},
  signal?: AbortSignal | null,
): Promise<GuardedResponse> {
  const target = await checkTarget(url, policy, deps.resolve ?? systemResolver);
  const res = await (deps.transport ?? nodeTransport)(
    target,
    { method: req.method ?? 'GET', headers: req.headers ?? {}, body: req.body ?? null },
    {
      maxBytes: policy.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (res.status >= 300 && res.status < 400)
    throw new NetGuardError(
      'REDIRECT_REFUSED',
      `HTTP ${res.status} to ${res.headers['location'] ?? '(no Location)'} was not followed`,
    );
  return { ...res, target };
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function bodyOf(init?: RequestInit): Uint8Array | null {
  const b = init?.body;
  if (b === undefined || b === null) return null;
  if (typeof b === 'string') return new TextEncoder().encode(b);
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  throw new NetGuardError('URL_INVALID', 'only string or byte request bodies are supported');
}

/**
 * A `fetch`-compatible function for code that takes one (the x402 buyer).
 * Every call goes through `guardedRequest`; the Response is built from the
 * capped body.
 */
export function createGuardedFetch(
  policy: NetGuardPolicy = {},
  deps: GuardedFetchDeps = {},
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const res = await guardedRequest(
      url,
      { method: init?.method ?? 'GET', headers: headersOf(init), body: bodyOf(init) },
      policy,
      deps,
      init?.signal ?? null,
    );
    const nullBody = res.status === 204 || res.status === 304 || res.status < 200;
    return new Response(nullBody ? null : (res.body as Uint8Array<ArrayBuffer>), {
      status: res.status,
      headers: res.headers,
    });
  }) as typeof globalThis.fetch;
}
