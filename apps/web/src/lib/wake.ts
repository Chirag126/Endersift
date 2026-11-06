/**
 * Waking the provider host from the visitor's browser (D-085), the pure part.
 *
 * On Render's free plan a sleeping service is started by a visitor's request,
 * but the agent's own server-side requests got HTTP 429 and did not start it
 * (2026-11-06). So the web app asks the provider host's /health from the
 * browser: on load, again every few seconds while it is waking, and every few
 * minutes while the page stays open and visible. It reads only `status`.
 */

export type WakeState = 'off' | 'waking' | 'ready' | 'unreachable';

/** While waking: ask again this often, for at most WAKE_GIVE_UP_MS. */
export const WAKE_RETRY_MS = 10_000;
export const WAKE_GIVE_UP_MS = 180_000;
/** Once up: ask again this often while the page is visible (the host sleeps after 15 min idle). */
export const WAKE_KEEP_MS = 5 * 60_000;
/** One request may wait this long: a cold start holds the first request about a minute. */
export const WAKE_REQUEST_TIMEOUT_MS = 100_000;

/** Is this /health answer the provider host up? Only `{ status: "ok" }` counts. */
export function healthIsUp(status: number, body: unknown): boolean {
  return (
    status === 200 &&
    typeof body === 'object' &&
    body !== null &&
    (body as Record<string, unknown>)['status'] === 'ok'
  );
}

/** The next state after one answer (or none), and when to ask again (ms; null = stop). */
export function nextWake(
  up: boolean,
  sinceFirstMs: number,
): { readonly state: WakeState; readonly againMs: number | null } {
  if (up) return { state: 'ready', againMs: WAKE_KEEP_MS };
  if (sinceFirstMs + WAKE_RETRY_MS <= WAKE_GIVE_UP_MS)
    return { state: 'waking', againMs: WAKE_RETRY_MS };
  return { state: 'unreachable', againMs: WAKE_KEEP_MS };
}

export const WAKE_TEXT: Readonly<Record<WakeState, string>> = {
  off: '',
  waking: 'Provider host waking up',
  ready: 'Provider host ready',
  unreachable: 'Provider host not answering',
};
