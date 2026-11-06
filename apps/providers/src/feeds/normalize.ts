/**
 * Helpers for turning untrusted upstream JSON into the normalised IntelItem
 * shape (packages/core/src/domain/intel.ts). Dependency-free; every helper
 * tolerates missing or wrongly typed input and never throws.
 */
import type { IntelItem, IntelSeverity } from '@agent-economy/core/domain';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export type Json = Record<string, unknown>;
export const obj = (v: unknown): Json | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Strip control characters (tab/newline kept), collapse runs of spaces, trim, cap. */
export function clean(v: unknown, max: number): string {
  const s = str(v);
  if (s === null) return '';
  const t = s
    .replace(CONTROL, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export const cleanOrNull = (v: unknown, max: number): string | null => {
  const c = clean(v, max);
  return c === '' ? null : c;
};

/** YYYY-MM-DD from "2024-01-31", "2024-01-31T10:00:00.000" or "2024-01-31T10:00:00Z"; else null. */
export function isoDate(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(s.trim());
  if (m === null || m[1] === undefined) return null;
  const d = new Date(`${m[1]}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[1] ? null : m[1];
}

const ADVISORY = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/;
export const advisoryId = (v: unknown): string | null => {
  const s = str(v)?.trim() ?? null;
  return s !== null && ADVISORY.test(s) ? s : null;
};

export function advisoryIds(v: unknown, max = 32, exclude?: string): string[] {
  const out: string[] = [];
  for (const x of arr(v)) {
    const id = advisoryId(x);
    if (id !== null && id !== exclude && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** https references only, de-duplicated, at most `max`. */
export function httpsRefs(urls: readonly unknown[], max = 10): string[] {
  const out: string[] = [];
  for (const u of urls) {
    const s = str(u)?.trim();
    if (s === undefined || s.length > 2048) continue;
    try {
      const parsed = new URL(s);
      if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '')
        continue;
    } catch {
      continue;
    }
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function severityFromScore(score: number | null): IntelSeverity {
  if (score === null) return 'unknown';
  if (score === 0) return 'none';
  if (score < 4) return 'low';
  if (score < 7) return 'medium';
  if (score < 9) return 'high';
  return 'critical';
}

export function severityFromLabel(v: unknown): IntelSeverity {
  switch (str(v)?.trim().toUpperCase()) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
    case 'MODERATE':
      return 'medium';
    case 'LOW':
      return 'low';
    case 'NONE':
      return 'none';
    default:
      return 'unknown';
  }
}

/** CVSS version from a vector ("CVSS:3.1/…" → "3.1", "CVSS:4.0/…" → "4.0", v2 vectors → "2.0"). */
export function cvssVersionFromVector(vector: string): string | null {
  const m = /^CVSS:([34]\.[01])\//.exec(vector);
  if (m !== null && m[1] !== undefined) return m[1];
  return /^AV:[LAN]\/AC:[HML]\/Au:[MSN]\//.test(vector) ? '2.0' : null;
}

export function cwes(values: readonly unknown[], max = 16): string[] {
  const out: string[] = [];
  for (const v of values) {
    const s = str(v)?.trim();
    if (s !== undefined && /^CWE-\d{1,6}$/.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** An item with every optional field empty; normalisers fill what their source has. */
export function emptyItem(id: string): IntelItem {
  return {
    id,
    aliases: [],
    title: '',
    summary: '',
    severity: 'unknown',
    cvss: null,
    published: null,
    modified: null,
    cwes: [],
    vendor: null,
    product: null,
    exploited: null,
    affected: [],
    references: [],
  };
}
