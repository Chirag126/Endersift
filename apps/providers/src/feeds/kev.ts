/**
 * CISA Known Exploited Vulnerabilities catalogue (public domain).
 * Feed fields per CISA's schema: title, catalogVersion, dateReleased, count,
 * vulnerabilities[]{cveID, vendorProject, product, vulnerabilityName,
 * dateAdded, shortDescription, requiredAction, dueDate,
 * knownRansomwareCampaignUse ("Known" | "Unknown"), notes, cwes[]}.
 */
import type { IntelItem } from '@agent-economy/core/domain';
import { TtlCache, UpstreamError, fetchJson } from './http.ts';
import {
  advisoryId,
  arr,
  clean,
  cleanOrNull,
  cwes,
  emptyItem,
  httpsRefs,
  isoDate,
  obj,
  str,
} from './normalize.ts';

export const KEV_SOURCE = {
  name: 'CISA Known Exploited Vulnerabilities catalog',
  url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
  license: 'Public domain (US government work)',
} as const;

export interface KevCatalog {
  readonly version: string | null;
  readonly released: string | null;
  readonly items: readonly IntelItem[];
  /** Entries dropped because their CVE ID or dateAdded was unusable. */
  readonly skipped: number;
}

export function normalizeKevEntry(raw: unknown): IntelItem | null {
  const e = obj(raw);
  if (e === null) return null;
  const id = advisoryId(e['cveID']);
  const dateAdded = isoDate(e['dateAdded']);
  if (id === null || !id.startsWith('CVE-') || dateAdded === null) return null;
  const notes = str(e['notes']) ?? '';
  return {
    ...emptyItem(id),
    title: clean(e['vulnerabilityName'], 300),
    summary: clean(e['shortDescription'], 4000),
    cwes: cwes(arr(e['cwes'])),
    vendor: cleanOrNull(e['vendorProject'], 120),
    product: cleanOrNull(e['product'], 120),
    exploited: {
      dateAdded,
      dueDate: isoDate(e['dueDate']),
      ransomware:
        str(e['knownRansomwareCampaignUse'])?.trim().toLowerCase() === 'known'
          ? 'known'
          : 'unknown',
      requiredAction: clean(e['requiredAction'], 1000),
    },
    // `notes` holds reference URLs separated by " ; " (plus free text).
    references: httpsRefs(notes.match(/https:\/\/[^\s;]+/g) ?? []),
  };
}

export function parseKevCatalog(json: unknown): KevCatalog {
  const root = obj(json);
  const entries = arr(root?.['vulnerabilities']);
  const items: IntelItem[] = [];
  let skipped = 0;
  for (const e of entries) {
    const item = normalizeKevEntry(e);
    if (item === null) skipped += 1;
    else items.push(item);
  }
  return {
    version: cleanOrNull(root?.['catalogVersion'], 64),
    released: cleanOrNull(root?.['dateReleased'], 64),
    items,
    skipped,
  };
}

/** Entries added on or after `since`, newest first (then by ID), at most `limit`. */
export function kevAddedSince(
  catalog: KevCatalog,
  since: string,
  limit: number,
): { items: IntelItem[]; truncated: boolean } {
  const matching = catalog.items
    .filter((i) => (i.exploited?.dateAdded ?? '') >= since)
    .sort((a, b) => {
      const da = a.exploited?.dateAdded ?? '';
      const db = b.exploited?.dateAdded ?? '';
      return da === db ? (a.id < b.id ? -1 : 1) : da < db ? 1 : -1;
    });
  return { items: matching.slice(0, limit), truncated: matching.length > limit };
}

export interface KevFeedOptions {
  fetch?: typeof globalThis.fetch;
  ttlMs?: number;
  now?: () => number;
}

export class KevFeed {
  private readonly cache: TtlCache<KevCatalog>;

  private readonly options: KevFeedOptions;

  constructor(options: KevFeedOptions = {}) {
    this.options = options;
    this.cache = new TtlCache(options.ttlMs ?? 60 * 60 * 1000, 1, options.now);
  }

  async catalog(): Promise<{ catalog: KevCatalog; fetchedAt: number }> {
    const { value, fetchedAt } = await this.cache.get('catalog', async () => {
      const json = await fetchJson(KEV_SOURCE.url, {
        maxBytes: 16 * 1024 * 1024,
        timeoutMs: 30_000,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      });
      const catalog = parseKevCatalog(json);
      if (catalog.items.length === 0)
        throw new UpstreamError('the KEV feed contained no usable entries', 502);
      return catalog;
    });
    return { catalog: value, fetchedAt };
  }
}
