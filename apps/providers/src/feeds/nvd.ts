/**
 * NIST National Vulnerability Database, CVE API 2.0.
 * GET https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=<id>, optional
 * `apiKey` header. Public limits: 5 requests / 30 s without a key, 50 with one.
 * Response: vulnerabilities[].cve{id, published, lastModified, descriptions[]
 * {lang,value}, metrics{cvssMetricV40|V31|V30|V2[]{type, cvssData{version,
 * baseScore, baseSeverity, vectorString}, baseSeverity (v2)}}, weaknesses[]
 * {description[]{value}}, references[]{url}}.
 */
import type { IntelItem } from '@agent-economy/core/domain';
import { RollingLimiter, TtlCache, UpstreamError, fetchJson } from './http.ts';
import {
  arr,
  clean,
  cwes,
  emptyItem,
  httpsRefs,
  isoDate,
  obj,
  severityFromLabel,
  severityFromScore,
  str,
} from './normalize.ts';

export const NVD_SOURCE = {
  name: 'NIST National Vulnerability Database (CVE API 2.0)',
  url: 'https://services.nvd.nist.gov/rest/json/cves/2.0',
  license:
    'Public data. This product uses the NVD API but is not endorsed or certified by the NVD.',
} as const;

export const CVE_ID = /^CVE-\d{4}-\d{4,7}$/;
/** NVD's public limit without a key makes larger batches impractical per paid request. */
export const MAX_CVE_IDS = 5;

const METRIC_KEYS = ['cvssMetricV40', 'cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2'] as const;

function pickMetric(metrics: Record<string, unknown> | null) {
  for (const key of METRIC_KEYS) {
    const list = arr(metrics?.[key])
      .map(obj)
      .filter((m) => m !== null);
    const chosen = list.find((m) => str(m['type']) === 'Primary') ?? list[0];
    if (chosen === undefined) continue;
    const data = obj(chosen['cvssData']);
    const score = typeof data?.['baseScore'] === 'number' ? data['baseScore'] : null;
    const version = str(data?.['version']);
    const vector = str(data?.['vectorString']);
    const label = data?.['baseSeverity'] ?? chosen['baseSeverity'];
    return {
      cvss: {
        version:
          version !== null && /^[234]\.[01]$/.test(version)
            ? version
            : key === 'cvssMetricV2'
              ? '2.0'
              : '3.1',
        score: score !== null && score >= 0 && score <= 10 ? score : null,
        vector: vector === null ? null : clean(vector, 200),
      },
      severity:
        severityFromLabel(label) !== 'unknown'
          ? severityFromLabel(label)
          : severityFromScore(score),
    };
  }
  return null;
}

/** Normalise the NVD answer for one requested CVE; null when NVD does not know it. */
export function normalizeNvdResponse(json: unknown, requestedId: string): IntelItem | null {
  const cve = arr(obj(json)?.['vulnerabilities'])
    .map((v) => obj(obj(v)?.['cve']))
    .find((c) => c !== null && str(c['id']) === requestedId);
  if (cve === undefined || cve === null) return null;
  const english = arr(cve['descriptions'])
    .map(obj)
    .find((d) => d !== null && str(d['lang']) === 'en');
  const summary = clean(english?.['value'], 4000);
  const metric = pickMetric(obj(cve['metrics']));
  const weaknessValues = arr(cve['weaknesses']).flatMap((w) =>
    arr(obj(w)?.['description']).map((d) => obj(d)?.['value']),
  );
  const firstSentence = summary.split(/(?<=\.)\s/)[0] ?? summary;
  return {
    ...emptyItem(requestedId),
    title: clean(firstSentence, 160),
    summary,
    severity: metric?.severity ?? 'unknown',
    cvss: metric?.cvss ?? null,
    published: isoDate(cve['published']),
    modified: isoDate(cve['lastModified']),
    cwes: cwes(weaknessValues),
    references: httpsRefs(arr(cve['references']).map((r) => obj(r)?.['url'])),
  };
}

export interface NvdClientOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  ttlMs?: number;
  now?: () => number;
  /** Longest wait for a rate-limit slot before answering 503 (no settlement). */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class NvdClient {
  private readonly cache: TtlCache<IntelItem | null>;
  private readonly limiter: RollingLimiter;

  private readonly options: NvdClientOptions;

  constructor(options: NvdClientOptions = {}) {
    this.options = options;
    this.cache = new TtlCache(options.ttlMs ?? 6 * 60 * 60 * 1000, 2000, options.now);
    this.limiter = new RollingLimiter(options.apiKey === undefined ? 5 : 50, 30_000, options.now);
  }

  private async slot(): Promise<void> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const maxWait = this.options.maxWaitMs ?? 8_000;
    let waited = 0;
    for (;;) {
      const wait = this.limiter.tryAcquire();
      if (wait === 0) return;
      if (waited + wait > maxWait) {
        throw new UpstreamError(
          'NVD rate limit reached; retry shortly',
          503,
          Math.ceil(wait / 1000),
        );
      }
      await sleep(wait);
      waited += wait;
    }
  }

  async lookup(
    ids: readonly string[],
  ): Promise<{ items: IntelItem[]; notFound: string[]; fetchedAt: number }> {
    const items: IntelItem[] = [];
    const notFound: string[] = [];
    let oldest = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      const { value, fetchedAt } = await this.cache.get(id, async () => {
        await this.slot();
        const json = await fetchJson(`${NVD_SOURCE.url}?cveId=${encodeURIComponent(id)}`, {
          timeoutMs: 20_000,
          maxBytes: 2 * 1024 * 1024,
          ...(this.options.apiKey === undefined
            ? {}
            : { headers: { apiKey: this.options.apiKey } }),
          ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        });
        return normalizeNvdResponse(json, id);
      });
      oldest = Math.min(oldest, fetchedAt);
      if (value === null) notFound.push(id);
      else items.push(value);
    }
    return { items, notFound, fetchedAt: Number.isFinite(oldest) ? oldest : Date.now() };
  }
}
