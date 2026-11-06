// Class: mock. The evidence checks of `pnpm agent:run`, fed with records from
// the MOCK orchestrator harness. This tests the checker, never the live run.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getRun, listRunEvents } from '../../apps/server/src/db/repositories.ts';
import {
  BUY_KEV,
  BUY_OSV,
  analysisJson,
  harness,
  planJson,
  type HarnessOptions,
} from '../../apps/server/test/support/orchestrator-harness.ts';
import { agentRunChecks, parseWatchlist, type AgentRunRecord } from '../lib/agent-run.ts';

async function record(o: HarnessOptions): Promise<AgentRunRecord> {
  const h = harness(o);
  const { run, report } = await h.orchestrator.run({ trigger: 'manual', watchlist: ['OpenSSL'] });
  const payments = await Promise.all(
    (await h.store.listByRun(run.id)).map(async (p) => ({
      ...p,
      history: await h.store.history(p.id),
      verifications: await h.store.verifications(p.id),
    })),
  );
  return {
    run: getRun(h.db, run.id) ?? run,
    events: listRunEvents(h.db, run.id),
    payments,
    calls: await h.ledger.listCalls({ runId: run.id }),
    report,
    ensBlock: 12_004_338n,
  };
}

const failed = (r: AgentRunRecord) =>
  agentRunChecks(r)
    .list.filter((c) => !c.ok)
    .map((c) => c.name);

describe('agentRunChecks', () => {
  it('a complete run passes every check', async () => {
    const r = await record({
      plan: () => planJson([BUY_KEV, BUY_OSV]),
      analysis: () => analysisJson(['CVE-2026-1001', 'GHSA-aaaa-bbbb-cccc']),
    });
    const c = agentRunChecks(r);
    assert.deepEqual(failed(r), []);
    assert.ok(c.verified);
    assert.equal(c.settled, 2);
  });

  it('fails without a Mirror Node verification, at another ENS block, or without the brief', async () => {
    const r = await record({
      plan: () => planJson([BUY_KEV]),
      analysis: () => analysisJson(['CVE-2026-1001']),
    });
    const [p] = r.payments;
    assert.ok(p !== undefined);
    assert.ok(
      failed({ ...r, payments: [{ ...p, verifications: [] }] }).some((n) =>
        n.includes('Mirror Node verification'),
      ),
    );
    assert.deepEqual(failed({ ...r, ensBlock: 1n }), [
      'providers discovered on ENS at the pinned block',
    ]);
    assert.ok(
      failed({ ...r, report: null }).includes(
        'brief written, citing every settled tx ID and 0G request ID',
      ),
    );
  });

  it('an UNKNOWN payment or a failed run is never verified', async () => {
    const r = await record({ mirror: 'none', plan: () => planJson([BUY_KEV]) });
    const names = failed(r);
    assert.ok(names.includes('run SUCCEEDED'));
    assert.ok(names.includes('at least one payment SETTLED'));
    assert.ok(names.includes('paid data fetched from a SETTLED purchase'));
    assert.equal(agentRunChecks(r).verified, false);
  });
});

describe('parseWatchlist', () => {
  it('splits, trims and dedupes; refuses empty, too many and too long', () => {
    assert.deepEqual(parseWatchlist(' OpenSSL, lodash@4.17.20 (npm);OpenSSL '), [
      'OpenSSL',
      'lodash@4.17.20 (npm)',
    ]);
    assert.throws(() => parseWatchlist(' , '), /1 to 20/);
    assert.throws(
      () =>
        parseWatchlist(
          Array(21)
            .fill(0)
            .map((_, i) => `x${i}`)
            .join(','),
        ),
      /1 to 20/,
    );
    assert.throws(() => parseWatchlist('x'.repeat(101)), /100 characters/);
  });
});
