/**
 * The built web app, served by the API on the same origin (D-062).
 *
 * One origin for the page and /api: no CORS, the session cookie stays
 * SameSite=Strict, the cross-site refusal (D-060) needs no exception, and the
 * live event stream goes straight to the browser without a proxy in between.
 *
 * Every file is read into memory once at startup from the build folder:
 * requests are answered from that table, so a request path never reaches the
 * file system (no traversal, no symlinks followed, no new files picked up).
 * Only known web file types are served; anything else is not in the table.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/**
 * The page may load only its own scripts, styles, images and fonts, and talk
 * only to its own origin (the API), plus the provider host it wakes (D-085).
 * No inline script, no framing.
 */
export function appCsp(connectOrigins: readonly string[] = []): string {
  return APP_CSP.replace("connect-src 'self'", ["connect-src 'self'", ...connectOrigins].join(' '));
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  // EnderPay click sound and any music the owner adds (D-072, D-073); same-origin under the CSP
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export interface StaticFile {
  readonly body: Buffer;
  readonly type: string;
  readonly cacheControl: string;
}

export class StaticSiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticSiteError';
  }
}

/** Read a built site into memory. Throws if it has no index.html or is too large. */
export function loadStaticSite(root: string): ReadonlyMap<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  let total = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      const type = TYPES[extname(name).toLowerCase()];
      if (type === undefined || !st.isFile()) continue;
      total += st.size;
      if (files.size >= MAX_FILES || total > MAX_TOTAL_BYTES)
        throw new StaticSiteError(`the web build at ${root} is larger than expected`);
      const path = `/${relative(root, p).split(sep).join('/')}`;
      files.set(path, {
        body: readFileSync(p),
        type,
        // hashed build assets never change; the page itself is revalidated every time
        cacheControl: path.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      });
    }
  };
  try {
    walk(root);
  } catch (error) {
    if (error instanceof StaticSiteError) throw error;
    throw new StaticSiteError(
      `the web build at ${root} cannot be read (run pnpm web:build): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const index = files.get('/index.html');
  if (index === undefined)
    throw new StaticSiteError(`${root} has no index.html (run pnpm web:build)`);
  files.set('/', index);
  return files;
}

/**
 * A single HTTP byte range (`Range: bytes=a-b`, `bytes=a-`, `bytes=-n`) for a
 * file of `size` bytes (D-074). Browsers need ranges to seek inside audio that
 * is still downloading; without them a track cannot start at its set position.
 * `null` means "send the whole file" (no header, another unit, several ranges,
 * or a malformed value: all allowed by RFC 9110); `'unsatisfiable'` means 416.
 * Pure.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    // the last n bytes
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return null;
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const last = b === '' ? size - 1 : Number(b);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(last)) return null;
  if (start >= size) return 'unsatisfiable';
  if (last < start) return null;
  return { start, end: Math.min(last, size - 1) };
}
