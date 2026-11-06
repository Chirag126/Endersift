// Class: unit. Synthetic fixtures shaped like each feed's documented schema;
// the CVE-2099-* identifiers are deliberately fictional.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RollingLimiter, TtlCache, UpstreamError, fetchJson } from '../src/feeds/http.ts';
import { kevAddedSince, normalizeKevEntry, parseKevCatalog } from '../src/feeds/kev.ts';
import { NvdClient, normalizeNvdResponse } from '../src/feeds/nvd.ts';
import { normalizeOsvResponse, normalizeOsvVuln } from '../src/feeds/osv.ts';
import {
  clean,
  cvssVersionFromVector,
  isoDate,
  severityFromScore,
} from '../src/feeds/normalize.ts';
import { OPERATIONS } from '../src/operations.ts';
import { KEV_FIXTURE, NVD_FIXTURE, OSV_FIXTURE } from './fixtures.ts';

const fakeResponse = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init });

describe('normalisers', () => {
  it('normalise CISA KEV entries and skip unusable ones', () => {
    const catalog = parseKevCatalog(KEV_FIXTURE);
    assert.equal(catalog.items.length, 2);
    assert.equal(catalog.skipped, 1);
    assert.equal(catalog.version, '2099.01.15');
    const first = catalog.items[0];
    assert.equal(first?.id, 'CVE-2099-0001');
    assert.equal(first?.vendor, 'Example Corp');
    assert.deepEqual(first?.exploited, {
      dateAdded: '2099-01-14',
      dueDate: '2099-02-04',
      ransomware: 'known',
      requiredAction: 'Apply mitigations per vendor instructions or discontinue use.',
    });
    assert.deepEqual(first?.references, [
      'https://example.com/advisory/1',
      'https://nvd.nist.gov/vuln/detail/CVE-2099-0001',
    ]);
    assert.deepEqual(first?.cwes, ['CWE-78']);
    assert.ok(!catalog.items[1]?.summary.includes('\u0000'), 'control characters stripped');
    assert.equal(
      normalizeKevEntry({ cveID: 'CVE-2099-9', dateAdded: '2099-02-30' }),
      null,
      'invalid date',
    );
  });

  it('select KEV additions since a date, newest first, with truncation', () => {
    const catalog = parseKevCatalog(KEV_FIXTURE);
    const all = kevAddedSince(catalog, '2099-01-01', 50);
    assert.deepEqual(
      all.items.map((i) => i.id),
      ['CVE-2099-0001', 'CVE-2099-0002'],
    );
    assert.equal(all.truncated, false);
    const one = kevAddedSince(catalog, '2099-01-01', 1);
    assert.equal(one.items.length, 1);
    assert.equal(one.truncated, true);
    assert.equal(kevAddedSince(catalog, '2099-01-15', 50).items.length, 0);
  });

  it('normalise an NVD CVE record: English text, primary CVSS, CWE, https references', () => {
    const item = normalizeNvdResponse(NVD_FIXTURE, 'CVE-2099-0001');
    assert.ok(item !== null);
    assert.equal(item.title, 'A command injection flaw allows remote code execution.');
    assert.equal(item.severity, 'critical');
    assert.deepEqual(item.cvss, {
      version: '3.1',
      score: 9.8,
      vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    });
    assert.equal(item.published, '2099-01-10');
    assert.equal(item.modified, '2099-01-14');
    assert.deepEqual(item.cwes, ['CWE-78']);
    assert.deepEqual(item.references, ['https://example.com/advisory/1']);
    assert.equal(normalizeNvdResponse(NVD_FIXTURE, 'CVE-2099-9999'), null, 'unknown CVE');
    assert.equal(normalizeNvdResponse({ vulnerabilities: [] }, 'CVE-2099-0001'), null);
  });

  it('normalise OSV advisories: aliases, severity label, ranges, paging', () => {
    const { items, truncated } = normalizeOsvResponse(OSV_FIXTURE);
    assert.equal(truncated, true, 'next_page_token present');
    assert.deepEqual(
      items.map((i) => i.id),
      ['GHSA-xxxx-yyyy-zzzz', 'PYSEC-2099-1'],
      'newest modified first',
    );
    const ghsa = items[0];
    assert.deepEqual(ghsa?.aliases, ['CVE-2099-0003']);
    assert.equal(ghsa?.severity, 'medium');
    assert.equal(ghsa?.cvss?.version, '3.1');
    assert.equal(ghsa?.cvss?.score, null, 'OSV carries vectors, not scores');
    assert.deepEqual(ghsa?.affected, [
      { ecosystem: 'npm', package: 'example-lib', ranges: [{ introduced: '0', fixed: '4.17.21' }] },
    ]);
    assert.deepEqual(ghsa?.cwes, ['CWE-1321']);
    assert.equal(items[1]?.title, 'PYSEC-2099-1', 'falls back to the id without a summary');
    assert.equal(normalizeOsvVuln({ id: '!' }), null);
  });

  it('helpers clean text, parse dates and map scores', () => {
    assert.equal(clean('  a\u0007b   c ', 10), 'ab c');
    assert.equal(clean('x'.repeat(20), 5), 'xxxx…');
    assert.equal(isoDate('2099-01-10T15:15:08.000'), '2099-01-10');
    assert.equal(isoDate('2099-13-01'), null);
    assert.equal(isoDate(42), null);
    assert.equal(severityFromScore(9.8), 'critical');
    assert.equal(severityFromScore(7.0), 'high');
    assert.equal(severityFromScore(null), 'unknown');
    assert.equal(cvssVersionFromVector('CVSS:4.0/AV:N'), '4.0');
    assert.equal(cvssVersionFromVector('AV:N/AC:L/Au:N/C:P/I:P/A:P'), '2.0');
  });
});

describe('fetchJson (untrusted upstream)', () => {
  it('returns parsed JSON and refuses non-https URLs', async () => {
    const json = await fetchJson('https://feed.example/x', {
      fetch: async () => fakeResponse('{"a":1}'),
    });
    assert.deepEqual(json, { a: 1 });
    await assert.rejects(
      fetchJson('http://feed.example/x', { fetch: async () => fakeResponse('{}') }),
      UpstreamError,
    );
  });

  it('maps failures to 502/503/504 and never follows redirects', async () => {
    let seenRedirect: RequestInit['redirect'];
    await fetchJson('https://feed.example/x', {
      fetch: async (_u, init) => {
        seenRedirect = init?.redirect;
        return fakeResponse('{}');
      },
    });
    assert.equal(seenRedirect, 'error');
    const status = async (f: typeof fetch) => {
      try {
        await fetchJson('https://feed.example/x', { fetch: f, maxBytes: 16 });
        return 'ok';
      } catch (e) {
        return e instanceof UpstreamError ? `${e.status}:${e.retryAfterSeconds ?? '-'}` : 'other';
      }
    };
    assert.equal(await status(async () => fakeResponse('x', { status: 500 })), '502:-');
    assert.equal(
      await status(async () =>
        fakeResponse('x', { status: 429, headers: { 'retry-after': '12' } }),
      ),
      '503:12',
    );
    assert.equal(await status(async () => fakeResponse('not json')), '502:-');
    assert.equal(
      await status(async () => fakeResponse('{"a":"' + 'x'.repeat(64) + '"}')),
      '502:-',
      'size cap',
    );
    assert.equal(
      await status(async () => {
        throw Object.assign(new Error('t'), { name: 'TimeoutError' });
      }),
      '504:-',
    );
    assert.equal(
      await status(async () => {
        throw new TypeError('fetch failed');
      }),
      '502:-',
    );
  });
});

describe('cache and rate limit', () => {
  it('caches for the TTL and shares one in-flight load', async () => {
    let t = 0;
    let loads = 0;
    const cache = new TtlCache<number>(1000, 10, () => t);
    const load = async () => {
      loads += 1;
      return loads;
    };
    const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);
    assert.equal(a.value, 1);
    assert.equal(b.value, 1);
    t = 500;
    assert.equal((await cache.get('k', load)).value, 1);
    t = 1500;
    assert.equal((await cache.get('k', load)).value, 2);
  });

  it('allows N requests per window, then reports the wait', () => {
    let t = 0;
    const limiter = new RollingLimiter(2, 30_000, () => t);
    assert.equal(limiter.tryAcquire(), 0);
    assert.equal(limiter.tryAcquire(), 0);
    assert.equal(limiter.tryAcquire(), 30_000);
    t = 30_000;
    assert.equal(limiter.tryAcquire(), 0);
  });

  it('answers 503 instead of waiting past the limit (NVD without a key)', async () => {
    let t = 0;
    const nvd = new NvdClient({
      now: () => t,
      maxWaitMs: 1000,
      sleep: async (ms) => {
        t += ms;
      },
      fetch: async () => fakeResponse(JSON.stringify(NVD_FIXTURE)),
    });
    const ids = [
      'CVE-2099-0001',
      'CVE-2099-0002',
      'CVE-2099-0003',
      'CVE-2099-0004',
      'CVE-2099-0005',
    ];
    const first = await nvd.lookup(ids);
    assert.equal(first.items.length, 1);
    assert.deepEqual(first.notFound, ids.slice(1));
    await assert.rejects(
      nvd.lookup(['CVE-2099-0006']),
      (e: unknown) => e instanceof UpstreamError && e.status === 503,
    );
    // cached ids do not consume the limit
    assert.equal((await nvd.lookup(['CVE-2099-0001'])).items.length, 1);
  });
});

describe('query validation (before payment)', () => {
  const now = new Date('2099-01-15T12:00:00.000Z');
  const v = (label: string, qs: string) =>
    OPERATIONS[label]?.validate(new URLSearchParams(qs), now);

  it('kev: since/limit with defaults and bounds', () => {
    assert.deepEqual(v('kev', ''), { ok: true, query: { since: '2099-01-08', limit: '50' } });
    assert.deepEqual(v('kev', 'since=2020-01-01&limit=5'), {
      ok: true,
      query: { since: '2021-11-03', limit: '5' },
    });
    for (const bad of [
      'since=2099-01-16',
      'since=2099-02-30',
      'limit=0',
      'limit=101',
      'limit=1e2',
      'x=1',
      'since=a&since=b',
    ]) {
      assert.equal(v('kev', bad)?.ok, false, bad);
    }
  });

  it('cve: 1-5 well-formed IDs, normalised', () => {
    assert.deepEqual(v('cve', 'ids=cve-2099-0001, CVE-2099-0001,CVE-2099-12345'), {
      ok: true,
      query: { ids: 'CVE-2099-0001,CVE-2099-12345' },
    });
    for (const bad of [
      '',
      'ids=',
      'ids=CVE-99-1',
      'ids=CVE-2099-1,CVE-2099-2,CVE-2099-3,CVE-2099-4,CVE-2099-5,CVE-2099-6',
    ]) {
      assert.equal(v('cve', bad)?.ok, false, bad);
    }
  });

  it('osv: known ecosystem, safe package and version', () => {
    assert.deepEqual(v('osv', 'ecosystem=npm&package=%40scope%2Fpkg&version=1.2.3'), {
      ok: true,
      query: { ecosystem: 'npm', package: '@scope/pkg', version: '1.2.3' },
    });
    for (const bad of [
      'ecosystem=NPM&package=x',
      'ecosystem=npm',
      'ecosystem=npm&package=a%20b',
      'ecosystem=npm&package=x&version=1%3B2',
    ]) {
      assert.equal(v('osv', bad)?.ok, false, bad);
    }
  });
});
