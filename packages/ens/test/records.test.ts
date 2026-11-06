import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_RECORD_KEYS,
  AGENT_RECORD_READ_KEYS,
  AGENT_RECORD_SPEC,
  agentRecordsToText,
  parseAgentRecords,
  parseCapabilities,
  type ParseResult,
} from '../src/records.ts';

const GOOD: Record<string, string> = {
  'agent.endpoint': 'https://providers.example.com/v1/kev',
  'agent.capabilities': 'known-exploited-vulns,cve-lookup',
  'agent.price': '100000',
  'x402.payTo': '0.0.11044329',
  'x402.network': 'hedera:testnet',
  'x402.asset': '0.0.0',
  'agent.status': 'active',
};

const problems = (r: ParseResult) => (r.ok ? [] : r.problems.map((p) => `${p.key}:${p.code}`));
const parse = (patch: Record<string, string | null>, opts = {}) =>
  parseAgentRecords({ ...GOOD, ...patch }, opts);

describe('agent record spec', () => {
  it('covers the seven required keys plus optional ENSIP-26/ENSIP-5 keys', () => {
    const required = AGENT_RECORD_SPEC.filter((s) => s.required).map((s) => s.key);
    assert.deepEqual(required, [
      'agent.endpoint',
      'agent.capabilities',
      'agent.price',
      'x402.payTo',
      'x402.network',
      'x402.asset',
      'agent.status',
    ]);
    assert.ok(AGENT_RECORD_READ_KEYS.includes('agent-context'));
    assert.ok(AGENT_RECORD_READ_KEYS.includes('agent-endpoint[x402]'));
    assert.equal(AGENT_RECORD_KEYS.payTo, 'x402.payTo');
  });

  it('reserves payout keys for the admin and delegates the rest', () => {
    const adminOnly = AGENT_RECORD_SPEC.filter((s) => s.writer === 'admin')
      .map((s) => s.key)
      .sort();
    assert.deepEqual(adminOnly, ['x402.asset', 'x402.network', 'x402.payTo']);
  });
});

describe('parseAgentRecords', () => {
  it('accepts a well-formed record set, sorting capabilities', () => {
    const r = parseAgentRecords(GOOD);
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.records.capabilities, ['cve-lookup', 'known-exploited-vulns']);
      assert.equal(r.records.context, null);
      assert.equal(r.records.network, 'hedera:testnet');
    }
  });

  it('reports every missing required key at once', () => {
    const r = parseAgentRecords({});
    assert.equal(problems(r).length, 7);
    assert.ok(problems(r).every((p) => p.endsWith(':MISSING')));
    // whitespace-only counts as missing
    assert.deepEqual(problems(parse({ 'agent.status': '   ' })), ['agent.status:MISSING']);
  });

  it('rejects malformed endpoints', () => {
    for (const bad of [
      'not a url',
      'http://providers.example.com',
      'https://user:pw@host.example',
      'ftp://x.example',
      'javascript:alert(1)',
    ]) {
      assert.deepEqual(problems(parse({ 'agent.endpoint': bad })), ['agent.endpoint:INVALID'], bad);
    }
    assert.deepEqual(problems(parse({ 'agent.endpoint': 'http://127.0.0.1:4021/v1/kev' })), [
      'agent.endpoint:INVALID',
    ]);
    assert.ok(
      parse({ 'agent.endpoint': 'http://127.0.0.1:4021/v1/kev' }, { allowLocalHttp: true }).ok,
    );
    assert.deepEqual(
      problems(parse({ 'agent.endpoint': 'http://evil.example' }, { allowLocalHttp: true })),
      ['agent.endpoint:INVALID'],
    );
  });

  it('rejects malformed capabilities', () => {
    for (const bad of [
      '',
      'Known-Exploited',
      'a,,b',
      'kev,kev',
      'x',
      'has space',
      '1abc',
      Array.from({ length: 17 }, (_, i) => `cap-${i}`).join(','),
    ]) {
      const r = parse({ 'agent.capabilities': bad });
      assert.ok(!r.ok, bad);
    }
    assert.deepEqual(parseCapabilities(' b-cap , a-cap '), ['a-cap', 'b-cap']);
  });

  it('rejects non-canonical or non-positive prices', () => {
    for (const bad of ['0', '-1', '01', '1.5', '1e6', '0x10', '100 tinybars', '9'.repeat(40)]) {
      assert.deepEqual(problems(parse({ 'agent.price': bad })), ['agent.price:INVALID'], bad);
    }
    assert.deepEqual(problems(parse({ 'agent.price': '9'.repeat(41) })), ['agent.price:TOO_LONG']);
  });

  it('rejects bad payout identities, assets and networks', () => {
    // An EVM address is not a Hedera account: refused (here by the length cap first).
    assert.ok(!parse({ 'x402.payTo': '0x1993BB58708a630AF1CC01304Dd851BDEccF9261' }).ok);
    assert.deepEqual(problems(parse({ 'x402.payTo': '0x1993' })), ['x402.payTo:INVALID']);
    assert.deepEqual(problems(parse({ 'x402.payTo': '1.2.3' })), ['x402.payTo:INVALID']);
    assert.deepEqual(problems(parse({ 'x402.asset': 'HBAR' })), ['x402.asset:INVALID']);
    assert.deepEqual(problems(parse({ 'x402.network': 'eip155:1' })), ['x402.network:INVALID']);
    assert.deepEqual(
      problems(parse({ 'x402.network': 'hedera:mainnet' }, { expectedNetwork: 'hedera:testnet' })),
      ['x402.network:NETWORK_MISMATCH'],
    );
  });

  it('rejects unknown statuses but parses paused/retired', () => {
    assert.deepEqual(problems(parse({ 'agent.status': 'ACTIVE' })), ['agent.status:INVALID']);
    for (const s of ['paused', 'retired']) assert.ok(parse({ 'agent.status': s }).ok, s);
  });

  it('enforces the ENSIP-26 endpoint mirror', () => {
    assert.ok(parse({ 'agent-endpoint[x402]': GOOD['agent.endpoint'] as string }).ok);
    assert.deepEqual(problems(parse({ 'agent-endpoint[x402]': 'https://other.example/v1/kev' })), [
      'agent-endpoint[x402]:CONFLICT',
    ]);
    assert.deepEqual(problems(parse({ 'agent-endpoint[x402]': 'nope' })), [
      'agent-endpoint[x402]:INVALID',
    ]);
  });

  it('caps lengths and rejects control characters without echoing values', () => {
    const huge = 'a'.repeat(4001);
    assert.deepEqual(problems(parse({ 'agent-context': huge })), ['agent-context:TOO_LONG']);
    const r = parse({ 'agent.status': 'active\u0000injected' });
    assert.deepEqual(problems(r), ['agent.status:CONTROL_CHARS']);
    if (!r.ok) assert.ok(r.problems.every((p) => !p.message.includes('injected')));
    // multi-line context is fine (tabs/newlines are not control-char violations)
    assert.ok(parse({ 'agent-context': '# Agent\n\n- serves KEV\tdata' }).ok);
  });

  it('collects problems across several keys', () => {
    const r = parse({ 'agent.price': '0', 'x402.payTo': 'bad', 'agent.status': 'gone' });
    assert.deepEqual(problems(r).sort(), [
      'agent.price:INVALID',
      'agent.status:INVALID',
      'x402.payTo:INVALID',
    ]);
  });
});

describe('agentRecordsToText', () => {
  it('round-trips and writes the ENSIP-26 mirror', () => {
    const parsed = parseAgentRecords(GOOD);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const text = agentRecordsToText({ ...parsed.records, context: 'Serves KEV data.' });
    assert.equal(text['agent-endpoint[x402]'], GOOD['agent.endpoint']);
    assert.equal(text['agent.capabilities'], 'cve-lookup,known-exploited-vulns');
    const again = parseAgentRecords(text);
    assert.ok(again.ok);
    if (again.ok) assert.equal(again.records.context, 'Serves KEV data.');
  });

  it('refuses to serialise invalid records', () => {
    const parsed = parseAgentRecords(GOOD);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    assert.throws(
      () => agentRecordsToText({ ...parsed.records, priceAtomic: '0' }),
      /refusing to serialise/,
    );
  });
});

describe('docs/ens-records.md', () => {
  it('lists every key of AGENT_RECORD_SPEC with its required flag and writer', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(new URL('../../../docs/ens-records.md', import.meta.url), 'utf8');
    for (const s of AGENT_RECORD_SPEC) {
      const row = doc.split('\n').find((l) => l.startsWith(`| \`${s.key}\``));
      assert.ok(row !== undefined, `${s.key} missing from docs/ens-records.md`);
      assert.match(
        row,
        new RegExp(`\\| ${s.required ? 'yes' : 'no'} +\\| ${s.writer} +\\|`),
        s.key,
      );
    }
  });
});
