/**
 * Small, defensive JSON-over-HTTPS helper shared by the Mirror Node and
 * facilitator clients: timeout, response size cap, content checks, and errors
 * that never echo response bodies verbatim beyond a short excerpt.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JsonRequestOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export class HttpJsonError extends Error {
  readonly status: number | undefined;
  readonly url: string;
  constructor(message: string, url: string, status?: number) {
    super(message);
    this.name = 'HttpJsonError';
    this.url = url;
    this.status = status;
  }
}

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
  /** Raw text as received (bounded by maxBytes), for evidence files. */
  readonly raw: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

export async function getJson(
  url: string,
  options: JsonRequestOptions = {},
): Promise<JsonResponse> {
  if (!url.startsWith('https://')) {
    throw new HttpJsonError('refusing non-https URL', url);
  }
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HttpJsonError(`request failed: ${reason}`, url);
  }

  const raw = await response.text();
  if (raw.length > maxBytes) {
    throw new HttpJsonError(`response exceeds ${maxBytes} bytes`, url, response.status);
  }
  if (!response.ok) {
    throw new HttpJsonError(
      `HTTP ${response.status}: ${raw.slice(0, 200).replace(/\s+/g, ' ')}`,
      url,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpJsonError('response is not valid JSON', url, response.status);
  }
  return { status: response.status, body, raw };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
