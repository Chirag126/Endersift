// Class: unit. The agent's brief for sale (D-066): what the provider service
// accepts from the agent's public API, and how it reads it. No network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NoBriefError, briefReader, parseAgentBrief } from '../src/brief.ts';
import { UpstreamError } from '../src/feeds/http.ts';

const BRIEF = {
  runId: '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a',
  watchlist: ['OpenSSL', 'lodash@4.17.21 (npm)'],
  finishedAt: '2026-10-29T00:20:00.000Z',
  environment: 'live',
  verdict: 'e2e-verified',
  digest: { items: [] },
  markdown: '# Threat brief',
  extra: 'dropped',
};

describe('parseAgentBrief', () => {
  it('passes on only the known fields', () => {
    const b = parseAgentBrief(BRIEF);
    assert.ok(b !== null);
    assert.equal(b.runId, BRIEF.runId);
    assert.equal((b as unknown as Record<string, unknown>)['extra'], undefined);
  });

  it('refuses anything that is not a brief', () => {
    for (const bad of [
      null,
      [],
      { ...BRIEF, runId: 'not-a-uuid' },
      { ...BRIEF, environment: 'staging' },
      { ...BRIEF, watchlist: 'OpenSSL' },
      { ...BRIEF, markdown: 'x'.repeat(200_001) },
      { ...BRIEF, finishedAt: 5 },
    ])
      assert.equal(parseAgentBrief(bad), null, JSON.stringify(bad)?.slice(0, 60));
  });
});

describe('briefReader', () => {
  const answer = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

  it('reads <agent>/api/briefs/latest; 404 means no brief yet; other failures are upstream errors', async () => {
    let asked = '';
    const ok = briefReader({
      agentUrl: 'https://agent.example/',
      production: true,
      fetch: (async (url: string | URL | Request) => {
        asked = String(url);
        return new Response(JSON.stringify(BRIEF), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal((await ok()).runId, BRIEF.runId);
    assert.equal(asked, 'https://agent.example/api/briefs/latest');
    await assert.rejects(
      briefReader({ agentUrl: 'https://a.example', production: true, fetch: answer(404, {}) })(),
      NoBriefError,
    );
    await assert.rejects(
      briefReader({ agentUrl: 'https://a.example', production: true, fetch: answer(500, {}) })(),
      (e: unknown) => e instanceof UpstreamError && e.status === 502,
    );
    await assert.rejects(
      briefReader({
        agentUrl: 'https://a.example',
        production: true,
        fetch: answer(200, { runId: 'x' }),
      })(),
      /unexpected brief/,
    );
  });

  it('http only for a local agent outside production', () => {
    assert.throws(
      () => briefReader({ agentUrl: 'http://agent.example', production: false }),
      /must be https/,
    );
    assert.throws(
      () => briefReader({ agentUrl: 'http://127.0.0.1:3001', production: true }),
      /must be https/,
    );
    assert.doesNotThrow(() =>
      briefReader({ agentUrl: 'http://127.0.0.1:3001', production: false }),
    );
  });
});
