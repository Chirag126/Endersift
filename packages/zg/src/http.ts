/**
 * Minimal JSON-over-HTTPS transport for the 0G Router: https only, timeout,
 * response size cap, no redirects (an Authorization header must never follow a
 * redirect to another host), and errors that never contain request headers.
 *
 * Non-2xx responses are returned, not thrown: the Router's error body carries
 * the request_id and error code we need for evidence. Nothing here retries.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON body, or undefined when the body is not JSON. */
  readonly body: unknown;
  /** Response text, bounded by maxBytes. */
  readonly text: string;
}

export class ZgTransportError extends Error {
  readonly url: string;
  constructor(message: string, url: string) {
    super(message);
    this.name = 'ZgTransportError';
    this.url = url;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface JsonRequest {
  readonly method: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  /** A multipart body (audio transcription); fetch sets the boundary. Not with `json`. */
  readonly form?: FormData;
}

export async function sendJson(
  url: string,
  request: JsonRequest,
  options: HttpOptions = {},
): Promise<RawResponse> {
  if (!url.startsWith('https://')) throw new ZgTransportError('refusing non-https URL', url);
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
  if (request.json !== undefined && request.form !== undefined)
    throw new ZgTransportError('a request has either a JSON or a multipart body', url);
  if (request.json !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers,
      ...(request.json === undefined ? {} : { body: JSON.stringify(request.json) }),
      ...(request.form === undefined ? {} : { body: request.form }),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    // fetch() hides the useful part (DNS, refused, TLS) in error.cause.
    const cause =
      error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    const reason =
      error instanceof Error ? `${error.name}: ${error.message}${cause}` : String(error);
    throw new ZgTransportError(`request failed: ${reason}`, url);
  }

  const text = await response.text();
  if (text.length > maxBytes) {
    throw new ZgTransportError(`response exceeds ${maxBytes} bytes`, url);
  }
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, headers: response.headers, body, text };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Untrusted server text made safe for one log line: no control chars, bounded. */
export function sanitizeText(value: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
