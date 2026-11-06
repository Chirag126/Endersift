// Class: unit. Needs zod via @agent-economy/core (CI and owner's machine).
// Every normaliser's output must satisfy the shared zod IntelItem schema.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IntelItem, IntelResponse } from '@agent-economy/core/domain';
import { parseKevCatalog } from '../src/feeds/kev.ts';
import { normalizeNvdResponse } from '../src/feeds/nvd.ts';
import { normalizeOsvResponse } from '../src/feeds/osv.ts';
import { KEV_FIXTURE, NVD_FIXTURE, OSV_FIXTURE } from './fixtures.ts';

describe('normalised items satisfy the domain schema', () => {
  it('KEV, NVD and OSV items all parse as IntelItem', () => {
    const items = [
      ...parseKevCatalog(KEV_FIXTURE).items,
      normalizeNvdResponse(NVD_FIXTURE, 'CVE-2099-0001'),
      ...normalizeOsvResponse(OSV_FIXTURE).items,
    ];
    assert.equal(items.length, 5);
    for (const item of items) {
      const r = IntelItem.safeParse(item);
      assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
    }
  });

  it('IntelResponse requires count to match the items', () => {
    const base = {
      provider: 'kev',
      operation: 'recent',
      source: {
        name: 'x',
        url: 'https://feed.example/x',
        license: 'x',
        fetchedAt: '2099-01-15T00:00:00.000Z',
        version: null,
      },
      query: { since: '2099-01-01' },
      truncated: false,
      notFound: [],
      items: parseKevCatalog(KEV_FIXTURE).items,
      servedAt: '2099-01-15T00:00:00.000Z',
    };
    assert.ok(IntelResponse.safeParse({ ...base, count: 2 }).success);
    assert.ok(!IntelResponse.safeParse({ ...base, count: 3 }).success);
    assert.ok(!IntelResponse.safeParse({ ...base, count: 2, extra: 1 }).success, 'strict');
  });
});
