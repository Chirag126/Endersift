/**
 * Access control for the API (plan row 26, D-048).
 *
 * Starting a task spends HBAR and 0G, so it needs the shared access code
 * (DEMO_ACCESS_CODE). A client presents it either as `Authorization: Bearer
 * <code>` (scripts, curl) or exchanges it once for a session cookie
 * (`POST /api/session`), which the browser's EventSource sends automatically.
 *
 * - The code is compared in constant time (SHA-256 of both, timingSafeEqual).
 * - Session tokens are signed, not stored (D-084): a random nonce and the
 *   expiry, with an HMAC-SHA256 under a key derived from the access code. A
 *   restart (Render free sleep, a redeploy) keeps everyone signed in for the
 *   12 hours; changing DEMO_ACCESS_CODE signs everyone out. Logging out adds
 *   the token to an in-memory revoked list until it expires.
 * - The cookie is HttpOnly, Path=/api, SameSite=Strict for same-site use, or
 *   SameSite=None; Secure when the frontend is on another https origin.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

export function codeMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(sha256(presented), sha256(expected));
}

export const SESSION_COOKIE = 'ae_session';

export interface CookieOptions {
  readonly secure: boolean;
  /** The frontend is on another site: SameSite=None (requires Secure). */
  readonly crossSite: boolean;
}

export class SessionStore {
  readonly #key: Buffer;
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  readonly #revoked = new Map<string, number>(); // sha256(token) hex → expiry

  /**
   * `secret` is the access code: the signing key is derived from it, so a new
   * code ends every session, and a restart (Render free sleep) ends none (D-084).
   */
  constructor(secret: string, ttlMs = 12 * 3600_000, max = 1000, now: () => number = Date.now) {
    this.#key = createHash('sha256').update(`endersift-session-v1\0${secret}`, 'utf8').digest();
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#now = now;
  }

  #mac(body: string): string {
    return createHmac('sha256', this.#key).update(body, 'utf8').digest('base64url');
  }

  create(): { token: string; maxAgeSec: number } {
    const body = `${randomBytes(16).toString('base64url')}.${this.#now() + this.#ttlMs}`;
    return { token: `${body}.${this.#mac(body)}`, maxAgeSec: Math.floor(this.#ttlMs / 1000) };
  }

  valid(token: string): boolean {
    const m = /^([A-Za-z0-9_-]{22}\.(\d{1,15}))\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (m === null) return false;
    const [, body = '', exp = '0', mac = ''] = m;
    const expected = Buffer.from(this.#mac(body));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    if (Number(exp) <= this.#now()) return false;
    return !this.#revoked.has(sha256(token).toString('hex'));
  }

  /** Logging out: refused until it expires (in memory; the browser's cookie is also cleared). */
  revoke(token: string): void {
    const m = /\.(\d{1,15})\.[^.]*$/.exec(token);
    if (m === null) return;
    const t = this.#now();
    for (const [k, exp] of this.#revoked) if (exp <= t) this.#revoked.delete(k);
    while (this.#revoked.size >= this.#max) {
      const oldest = this.#revoked.keys().next().value;
      if (oldest === undefined) break;
      this.#revoked.delete(oldest);
    }
    this.#revoked.set(sha256(token).toString('hex'), Number(m[1]));
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSec: number, o: CookieOptions): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/api',
    `Max-Age=${maxAgeSec}`,
    o.crossSite ? 'SameSite=None' : 'SameSite=Strict',
    ...(o.secure || o.crossSite ? ['Secure'] : []),
  ].join('; ');
}

export function clearedCookie(o: CookieOptions): string {
  return sessionCookie('', 0, o);
}

/** The bearer code from an Authorization header, or null. */
export function bearer(header: string | undefined): string | null {
  const m = /^Bearer ([\x21-\x7e]{1,200})$/.exec(header ?? '');
  return m?.[1] ?? null;
}
