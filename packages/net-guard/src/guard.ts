/**
 * Net-guard (plan row 23, D-045): outbound HTTP for URLs that come from
 * untrusted places (ENS records, 402 responses, model output).
 *
 *   1. URL       https only (http only to a loopback host, and only with the
 *                explicit development flag); no credentials; allowed ports
 *   2. DNS       resolve ALL addresses once; EVERY one must be public (a
 *                hostname that also resolves to 10.x is refused, even if it
 *                has a public address too)
 *   3. pinning   the connection goes to the checked address (custom lookup),
 *                with SNI and Host still the hostname, so a second DNS answer
 *                (rebinding) can never redirect the socket
 *   4. no redirects: any 3xx is an error (the Location is not followed)
 *   5. caps      time (DNS, then connect + headers + body, each within
 *                `timeoutMs`) and response bytes, checked against
 *                Content-Length and while streaming
 *
 * Errors are `NetGuardError` with a stable `code`, never the response body.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { classifyIp, type BlockedRange } from './ip.ts';

export const NET_GUARD_CODES = [
  'URL_INVALID',
  'SCHEME_NOT_ALLOWED',
  'CREDENTIALS_IN_URL',
  'PORT_NOT_ALLOWED',
  'DNS_FAILED',
  'ADDRESS_BLOCKED',
  'REDIRECT_REFUSED',
  'RESPONSE_TOO_LARGE',
  'TIMEOUT',
  'CONNECTION_FAILED',
] as const;
export type NetGuardCode = (typeof NET_GUARD_CODES)[number];

export class NetGuardError extends Error {
  readonly code: NetGuardCode;
  readonly detail: string;
  constructor(code: NetGuardCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'NetGuardError';
    this.code = code;
    this.detail = detail;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export interface NetGuardPolicy {
  /** Allowed ports (default [443]; the default port of the scheme is used when the URL has none). */
  readonly allowedPorts?: readonly number[];
  /**
   * Development only: allow http:// to a loopback host (127.0.0.0/8, ::1, localhost)
   * and allow loopback addresses. Off in production (the local provider service).
   */
  readonly allowLoopbackHttp?: boolean;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface CheckedTarget {
  readonly url: URL;
  readonly hostname: string;
  readonly port: number;
  /** The address the connection is pinned to. */
  readonly pinned: ResolvedAddress;
  /** Every address the name resolved to (all checked). */
  readonly resolved: readonly ResolvedAddress[];
}

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.']);

/** Steps 1–2: parse, then resolve and check every address. Pure apart from the resolver. */
export async function checkTarget(
  rawUrl: string,
  policy: NetGuardPolicy = {},
  resolve: Resolver = systemResolver,
): Promise<CheckedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NetGuardError('URL_INVALID', 'not an absolute URL');
  }
  if (url.username !== '' || url.password !== '')
    throw new NetGuardError('CREDENTIALS_IN_URL', 'URLs with user:password are refused');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literal = isIP(hostname) !== 0;
  const loopbackHost =
    LOOPBACK_NAMES.has(hostname) || (literal && classifyIp(hostname).blocked === 'LOOPBACK');
  const devLoopback = policy.allowLoopbackHttp === true && loopbackHost;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && devLoopback))
    throw new NetGuardError('SCHEME_NOT_ALLOWED', `${url.protocol} is not allowed (https only)`);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const ports = policy.allowedPorts ?? [443];
  if (!devLoopback && !ports.includes(port))
    throw new NetGuardError('PORT_NOT_ALLOWED', `port ${port} is not in [${ports.join(', ')}]`);

  let resolved: readonly ResolvedAddress[];
  if (literal) {
    resolved = [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }];
  } else {
    const dnsTimeout = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      resolved = await Promise.race([
        resolve(hostname),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new NetGuardError('TIMEOUT', `DNS for ${hostname} took over ${dnsTimeout} ms`),
              ),
            dnsTimeout,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof NetGuardError) throw error;
      throw new NetGuardError(
        'DNS_FAILED',
        `${hostname}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (resolved.length === 0) throw new NetGuardError('DNS_FAILED', `${hostname}: no addresses`);
  }
  for (const a of resolved) {
    const c = classifyIp(a.address);
    const allowed = c.blocked === null || (devLoopback && c.blocked === 'LOOPBACK');
    if (!allowed)
      throw new NetGuardError(
        'ADDRESS_BLOCKED',
        `${hostname} resolves to ${a.address} (${c.blocked as BlockedRange}${c.embeddedV4 === null ? '' : ` via ${c.embeddedV4}`})`,
      );
  }
  const pinned = resolved[0];
  if (pinned === undefined) throw new NetGuardError('DNS_FAILED', `${hostname}: no addresses`);
  return { url, hostname, port, pinned, resolved };
}
