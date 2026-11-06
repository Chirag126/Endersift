/**
 * The agent API client. Same origin (`/api`, proxied by Vite in development),
 * cookies included, JSON only. Every failure becomes an `ApiError` with the
 * API's stable code and a message written for people.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec: number | null;
  /** Every validation problem the server listed (policy saves), else empty. */
  readonly problems: readonly string[];
  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSec: number | null,
    problems: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.problems = problems;
  }
}

/** Plain-language messages for the API's error codes (D-048). Pure. */
export function describeApiError(
  code: string,
  status: number,
  retryAfterSec: number | null,
): string {
  const wait = retryAfterSec === null ? '' : ` Try again in ${retryAfterSec} s.`;
  switch (code) {
    case 'UNREACHABLE':
      return "Can't reach the agent API. Start it with pnpm api:start, then reload.";
    case 'ACCESS_DENIED':
      return 'That access code is not right.';
    case 'TOO_MANY_AUTH_FAILURES':
      return `Too many wrong access codes from this address.${wait}`;
    case 'RATE_LIMITED':
      return `Too many requests from this address.${wait}`;
    case 'TOO_MANY_TASKS':
      return `The hourly task limit for this address is reached.${wait}`;
    case 'QUEUE_FULL':
      return `Three tasks are already waiting. Let them finish first.${wait}`;
    case 'TOO_MANY_STREAMS':
      return 'Too many live views are open. Close another tab with a running task.';
    case 'INVALID_WATCHLIST':
    case 'INVALID_BUDGET':
      return 'The task was not started: check the watchlist and the budget.';
    case 'TASK_NOT_FOUND':
      return 'No task with this ID.';
    case 'REPORT_NOT_FOUND':
      return 'The brief is not written yet.';
    case 'PAYMENTS_PAUSED':
      return 'Payments are paused. Resume them under Spending rules before starting a task.';
    case 'POLICY_CONFLICT':
      return 'The rules were changed elsewhere since you opened this page. Reload them and try again.';
    case 'POLICY_INVALID':
      return 'The server refused these limits.';
    case 'APPROVAL_EXPIRED':
      return 'This request expired before your answer arrived. The payment was not made.';
    case 'APPROVAL_ALREADY_DECIDED':
      return 'This payment was already decided (by you in another tab, or by its timeout).';
    case 'APPROVAL_NOT_FOUND':
      return 'No such approval request on this server (its database may have been reset).';
    case 'EARNINGS_UNAVAILABLE':
      return 'The Hedera Mirror Node could not be read just now. Try again shortly.';
    case 'NO_BRIEF':
      return 'No finished brief yet.';
    case 'VOICE_OFF':
      return 'Voice input is off on this server (its speech model is not in the 0G catalog).';
    case 'TOO_MANY_TRANSCRIPTIONS':
      return `The hourly voice limit for this address is reached.${wait}`;
    case 'EMPTY_AUDIO':
      return 'Nothing was recorded. Try again.';
    case 'INVALID_VOICE_CALL':
      return 'That voice recording can no longer start a task. Record it again, or type the watchlist.';
    default:
      return status >= 500
        ? 'The agent API had an internal error. Check its terminal.'
        : `The request was refused (${code}).`;
  }
}

interface ErrorBody {
  readonly error?: string;
  readonly message?: string;
  readonly problems?: readonly string[];
}
type MaybeErrorBody = ErrorBody | null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'UNREACHABLE', describeApiError('UNREACHABLE', 0, null), null);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message: string | null = null;
    let problems: readonly string[] = [];
    if (type.includes('application/json')) {
      const body = (await res.json().catch(() => null)) as MaybeErrorBody;
      code = body?.error ?? code;
      message = body?.message ?? null;
      const listed = body?.problems;
      problems = Array.isArray(listed) ? listed : [];
    }
    // A proxy with no API behind it answers 502/504 without our JSON.
    if ((res.status === 502 || res.status === 504) && !type.includes('application/json'))
      code = 'UNREACHABLE';
    const retry = Number(res.headers.get('retry-after'));
    const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
    const known = describeApiError(code, res.status, retryAfter);
    throw new ApiError(
      res.status,
      code,
      (known.startsWith('The request was refused') ||
        code === 'TRANSCRIPTION_FAILED' ||
        code === 'TRANSCRIPTION_REFUSED') &&
        message !== null
        ? code.startsWith('TRANSCRIPTION_')
          ? `0G could not transcribe this clip (${message}). Type the watchlist instead, or try again later.`
          : message
        : known,
      retryAfter,
      problems,
    );
  }
  return (type.includes('application/json') ? await res.json() : await res.text()) as T;
}

/** A raw audio body (the voice task, D-076). */
export const postAudio = <T>(path: string, audio: Blob, type: string): Promise<T> =>
  request<T>(path, { method: 'POST', headers: { 'content-type': type }, body: audio });

export const getJson = <T>(path: string): Promise<T> => request<T>(path);
export const getText = (path: string): Promise<string> => request<string>(path);
export const postJson = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
export const putJson = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
export const deleteRequest = (path: string): Promise<void> =>
  request<void>(path, { method: 'DELETE' });
