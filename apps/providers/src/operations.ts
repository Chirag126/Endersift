/**
 * The paid operation of each provider (plan row 15): one route per agent
 * label, mounted under its ENS endpoint (`<agent.endpoint>/<operation>`).
 *
 *   GET /v1/kev/recent?since=YYYY-MM-DD&limit=N          CISA KEV entries added since a date
 *   GET /v1/cve/lookup?ids=CVE-…,CVE-…                    NVD records for up to 5 CVE IDs
 *   GET /v1/osv/query?ecosystem=npm&package=x&version=y   OSV advisories for a package
 *
 * Query validation is pure and runs before payment is requested, so a bad
 * request costs nothing. Handlers return the normalised IntelResponse body.
 */
import type { IntelItem } from '@agent-economy/core/domain';
import { KEV_SOURCE, kevAddedSince, type KevFeed } from './feeds/kev.ts';
import { CVE_ID, MAX_CVE_IDS, NVD_SOURCE, type NvdClient } from './feeds/nvd.ts';
import {
  OSV_ECOSYSTEMS,
  OSV_PACKAGE,
  OSV_SOURCE,
  OSV_VERSION,
  type OsvClient,
} from './feeds/osv.ts';

export type QueryResult =
  | { readonly ok: true; readonly query: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly error: string };

export interface Feeds {
  readonly kev: KevFeed;
  readonly nvd: NvdClient;
  readonly osv: OsvClient;
}

export interface OperationOutput {
  readonly source: {
    name: string;
    url: string;
    license: string;
    fetchedAt: string;
    version: string | null;
  };
  readonly items: IntelItem[];
  readonly truncated: boolean;
  readonly notFound: string[];
}

export interface Operation {
  readonly label: string;
  readonly name: string;
  readonly description: string;
  readonly params: Readonly<Record<string, string>>;
  validate(params: URLSearchParams, now: Date): QueryResult;
  run(query: Readonly<Record<string, string>>, feeds: Feeds): Promise<OperationOutput>;
}

/** KEV started on 2021-11-03; nothing can be added before that. */
const KEV_START = '2021-11-03';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const iso = (ms: number) => new Date(ms).toISOString();

function validDate(v: string): boolean {
  return DATE.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;
}

function only(params: URLSearchParams, allowed: readonly string[]): string | null {
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key)) return `unknown parameter "${key.slice(0, 40)}"`;
    if (params.getAll(key).length > 1) return `parameter "${key}" given more than once`;
  }
  return null;
}

export const OPERATIONS: Readonly<Record<string, Operation>> = {
  kev: {
    label: 'kev',
    name: 'recent',
    description: 'CISA KEV entries added on or after a date, newest first.',
    params: { since: 'YYYY-MM-DD (default: 7 days ago)', limit: '1-100 (default 50)' },
    validate(params, now) {
      const bad = only(params, ['since', 'limit']);
      if (bad !== null) return { ok: false, error: bad };
      const today = now.toISOString().slice(0, 10);
      const since =
        params.get('since') ?? new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
      if (!validDate(since)) return { ok: false, error: 'since must be a valid YYYY-MM-DD date' };
      if (since > today) return { ok: false, error: 'since must not be in the future' };
      const limit = params.get('limit') ?? '50';
      if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
        return { ok: false, error: 'limit must be an integer from 1 to 100' };
      }
      return {
        ok: true,
        query: { since: since < KEV_START ? KEV_START : since, limit: String(Number(limit)) },
      };
    },
    async run(query, feeds) {
      const { catalog, fetchedAt } = await feeds.kev.catalog();
      const { items, truncated } = kevAddedSince(
        catalog,
        query['since'] ?? KEV_START,
        Number(query['limit']),
      );
      return {
        source: { ...KEV_SOURCE, fetchedAt: iso(fetchedAt), version: catalog.version },
        items,
        truncated,
        notFound: [],
      };
    },
  },
  cve: {
    label: 'cve',
    name: 'lookup',
    description: `NVD CVE records (description, CVSS, CWE, references) for 1-${MAX_CVE_IDS} CVE IDs.`,
    params: { ids: `comma-separated CVE IDs, at most ${MAX_CVE_IDS}` },
    validate(params) {
      const bad = only(params, ['ids']);
      if (bad !== null) return { ok: false, error: bad };
      const raw = params.get('ids');
      if (raw === null || raw.trim() === '') return { ok: false, error: 'ids is required' };
      const ids = [...new Set(raw.split(',').map((s) => s.trim().toUpperCase()))];
      if (ids.length > MAX_CVE_IDS)
        return { ok: false, error: `at most ${MAX_CVE_IDS} CVE IDs per request` };
      if (!ids.every((id) => CVE_ID.test(id)))
        return { ok: false, error: 'every id must look like CVE-YYYY-NNNN' };
      return { ok: true, query: { ids: ids.join(',') } };
    },
    async run(query, feeds) {
      const ids = (query['ids'] ?? '').split(',').filter((s) => s !== '');
      const { items, notFound, fetchedAt } = await feeds.nvd.lookup(ids);
      return {
        source: { ...NVD_SOURCE, fetchedAt: iso(fetchedAt), version: '2.0' },
        items,
        truncated: false,
        notFound,
      };
    },
  },
  osv: {
    label: 'osv',
    name: 'query',
    description: 'OSV advisories affecting a package (optionally a specific version).',
    params: {
      ecosystem: OSV_ECOSYSTEMS.join(' | '),
      package: 'package name',
      version: 'optional version',
    },
    validate(params) {
      const bad = only(params, ['ecosystem', 'package', 'version']);
      if (bad !== null) return { ok: false, error: bad };
      const ecosystem = params.get('ecosystem') ?? '';
      if (!(OSV_ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
        return { ok: false, error: `ecosystem must be one of ${OSV_ECOSYSTEMS.join(', ')}` };
      }
      const pkg = params.get('package') ?? '';
      if (!OSV_PACKAGE.test(pkg))
        return { ok: false, error: 'package is missing or contains unsupported characters' };
      const version = params.get('version');
      if (version !== null && !OSV_VERSION.test(version)) {
        return { ok: false, error: 'version contains unsupported characters' };
      }
      return {
        ok: true,
        query: { ecosystem, package: pkg, ...(version === null ? {} : { version }) },
      };
    },
    async run(query, feeds) {
      const version = query['version'];
      const { items, truncated, fetchedAt } = await feeds.osv.query({
        ecosystem: query['ecosystem'] ?? '',
        package: query['package'] ?? '',
        ...(version === undefined ? {} : { version }),
      });
      return {
        source: { ...OSV_SOURCE, fetchedAt: iso(fetchedAt), version: null },
        items,
        truncated,
        notFound: [],
      };
    },
  },
};

export const operationPath = (label: string, name: string): string => `/v1/${label}/${name}`;
