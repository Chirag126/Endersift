/**
 * OSV.dev (open-source vulnerability database).
 * POST https://api.osv.dev/v1/query {package{name, ecosystem}, version?}
 * → {vulns[]{id, summary, details, aliases, modified, published,
 *    severity[]{type, score}, affected[]{package{ecosystem,name}, ranges[]
 *    {type, events[]{introduced|fixed}}}, references[]{type,url},
 *    database_specific}, next_page_token}.
 */
import type { IntelItem } from '@agent-economy/core/domain';
import { TtlCache, fetchJson } from './http.ts';
import {
  advisoryId,
  advisoryIds,
  arr,
  clean,
  cvssVersionFromVector,
  cwes,
  emptyItem,
  httpsRefs,
  isoDate,
  obj,
  severityFromLabel,
  str,
} from './normalize.ts';

export const OSV_SOURCE = {
  name: 'OSV.dev vulnerability database',
  url: 'https://api.osv.dev/v1/query',
  license: 'CC-BY 4.0 unless an advisory states otherwise (osv.dev)',
} as const;

export const OSV_ECOSYSTEMS = [
  'npm',
  'PyPI',
  'Go',
  'Maven',
  'crates.io',
  'NuGet',
  'RubyGems',
  'Packagist',
  'Pub',
  'Hex',
] as const;
export const OSV_PACKAGE = /^[A-Za-z0-9@._/:+-]{1,214}$/;
export const OSV_VERSION = /^[A-Za-z0-9.+_:~-]{1,64}$/;
export const OSV_MAX_ITEMS = 100;

function ranges(raw: unknown) {
  const out: { introduced: string | null; fixed: string | null }[] = [];
  for (const r of arr(raw)) {
    let introduced: string | null = null;
    for (const ev of arr(obj(r)?.['events'])) {
      const e = obj(ev);
      if (e === null) continue;
      if (typeof e['introduced'] === 'string') introduced = clean(e['introduced'], 64);
      if (typeof e['fixed'] === 'string') {
        out.push({ introduced, fixed: clean(e['fixed'], 64) });
        introduced = null;
      }
    }
    if (introduced !== null) out.push({ introduced, fixed: null });
    if (out.length >= 16) break;
  }
  return out.slice(0, 16);
}

export function normalizeOsvVuln(raw: unknown): IntelItem | null {
  const v = obj(raw);
  const id = advisoryId(v?.['id']);
  if (v === null || id === null) return null;
  const dbSpecific = obj(v['database_specific']);
  const vector = arr(v['severity'])
    .map(obj)
    .map((s) => str(s?.['score']))
    .find((s): s is string => s !== null && cvssVersionFromVector(s) !== null);
  const summary = clean(v['summary'], 300);
  return {
    ...emptyItem(id),
    aliases: advisoryIds(v['aliases'], 32, id),
    title: summary === '' ? id : summary,
    summary: clean(v['details'], 4000) || summary,
    severity: severityFromLabel(dbSpecific?.['severity']),
    cvss:
      vector === undefined
        ? null
        : {
            version: cvssVersionFromVector(vector) ?? '3.1',
            score: null,
            vector: clean(vector, 200),
          },
    published: isoDate(v['published']),
    modified: isoDate(v['modified']),
    cwes: cwes(arr(dbSpecific?.['cwe_ids'])),
    affected: arr(v['affected'])
      .map(obj)
      .filter((a) => a !== null)
      .map((a) => {
        const pkg = obj(a['package']);
        return {
          ecosystem: clean(pkg?.['ecosystem'], 40),
          package: clean(pkg?.['name'], 214),
          ranges: ranges(a['ranges']),
        };
      })
      .filter((a) => a.package !== '')
      .slice(0, 20),
    references: httpsRefs(arr(v['references']).map((r) => obj(r)?.['url'])),
  };
}

export interface OsvQuery {
  readonly ecosystem: string;
  readonly package: string;
  readonly version?: string;
}

export function normalizeOsvResponse(json: unknown): { items: IntelItem[]; truncated: boolean } {
  const root = obj(json);
  const items = arr(root?.['vulns'])
    .map(normalizeOsvVuln)
    .filter((i): i is IntelItem => i !== null)
    .sort((a, b) =>
      (b.modified ?? '') < (a.modified ?? '')
        ? -1
        : (b.modified ?? '') > (a.modified ?? '')
          ? 1
          : a.id < b.id
            ? -1
            : 1,
    );
  const paged = typeof root?.['next_page_token'] === 'string' && root['next_page_token'] !== '';
  return { items: items.slice(0, OSV_MAX_ITEMS), truncated: paged || items.length > OSV_MAX_ITEMS };
}

export interface OsvClientOptions {
  fetch?: typeof globalThis.fetch;
  ttlMs?: number;
  now?: () => number;
}

export class OsvClient {
  private readonly cache: TtlCache<{ items: IntelItem[]; truncated: boolean }>;

  private readonly options: OsvClientOptions;

  constructor(options: OsvClientOptions = {}) {
    this.options = options;
    this.cache = new TtlCache(options.ttlMs ?? 60 * 60 * 1000, 1000, options.now);
  }

  async query(q: OsvQuery): Promise<{ items: IntelItem[]; truncated: boolean; fetchedAt: number }> {
    const key = `${q.ecosystem}\u0000${q.package}\u0000${q.version ?? ''}`;
    const { value, fetchedAt } = await this.cache.get(key, async () =>
      normalizeOsvResponse(
        await fetchJson(OSV_SOURCE.url, {
          method: 'POST',
          body: {
            package: { name: q.package, ecosystem: q.ecosystem },
            ...(q.version === undefined ? {} : { version: q.version }),
          },
          timeoutMs: 20_000,
          maxBytes: 8 * 1024 * 1024,
          ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        }),
      ),
    );
    return { ...value, fetchedAt };
  }
}
