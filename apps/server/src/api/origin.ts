/**
 * Cross-site request refusal for state-changing requests (D-060).
 *
 * The API already resists CSRF without this: writes need a JSON body (a
 * cross-site form cannot send one without a CORS preflight, and the preflight
 * is refused for any origin but API_CORS_ORIGIN), and the session cookie is
 * SameSite=Strict for a same-site frontend. This is the second, explicit
 * layer: a POST, PUT or DELETE that a browser marks as coming from another
 * site is refused before any handler runs, whatever the content type.
 *
 * Decision, in order:
 *   1. GET, HEAD and OPTIONS are never refused here (OPTIONS has its own check).
 *   2. Origin equal to the configured CORS origin: allowed.
 *   3. Sec-Fetch-Site (sent by current browsers, cannot be set by page script):
 *      "same-origin" or "none" allowed; "same-site" or "cross-site" refused.
 *      Through the Vite proxy or a Render rewrite the page and /api share one
 *      origin, so the browser says "same-origin".
 *   4. No Sec-Fetch-Site (older browsers, scripts): no Origin is allowed (curl,
 *      the check scripts; they hold the access code or get 401 anyway); an
 *      Origin whose host equals the Host header is allowed; any other refused.
 * Pure.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckInput {
  readonly method: string | undefined;
  readonly origin: string | undefined;
  readonly secFetchSite: string | undefined;
  readonly host: string | undefined;
  readonly corsOrigin: string | null;
}

/** True when the request must be refused as cross-site. */
export function crossSiteRefused(i: OriginCheckInput): boolean {
  if (SAFE_METHODS.has((i.method ?? 'GET').toUpperCase())) return false;
  if (i.origin !== undefined && i.corsOrigin !== null && i.origin === i.corsOrigin) return false;
  const site = i.secFetchSite?.toLowerCase();
  if (site !== undefined && site !== '') return site !== 'same-origin' && site !== 'none';
  if (i.origin === undefined || i.origin === '') return false;
  if (i.origin === 'null') return true; // sandboxed frames, file: pages
  try {
    return new URL(i.origin).host !== (i.host ?? '').toLowerCase();
  } catch {
    return true;
  }
}
