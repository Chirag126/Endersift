// Needs zod via @agent-economy/core (CI and owner's machine).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toProviderAgent } from '../src/provider.ts';
import { parseAgentRecords } from '../src/records.ts';

const RAW = {
  'agent.endpoint': 'https://providers.example.com/v1/kev',
  'agent.capabilities': 'known-exploited-vulns',
  'agent.price': '100000',
  'x402.payTo': '0.0.11044329',
  'x402.network': 'hedera:testnet',
  'x402.asset': '0.0.0',
  'agent.status': 'active',
};
const BASE = {
  ensName: 'kev.chirag126.eth',
  label: 'kev',
  chain: 'sepolia' as const,
  resolver: '0x1993BB58708a630AF1CC01304Dd851BDEccF9261',
  discoveredAt: '2026-10-27T00:00:00.000Z',
};

describe('toProviderAgent', () => {
  it('builds a domain provider from active records', () => {
    const parsed = parseAgentRecords(RAW);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const r = toProviderAgent({ ...BASE, records: parsed.records });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.provider.payTo, '0.0.11044329');
      assert.equal(r.provider.priceAtomic, '100000');
    }
  });

  it('skips paused or retired agents', () => {
    const parsed = parseAgentRecords({ ...RAW, 'agent.status': 'paused' });
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const r = toProviderAgent({ ...BASE, records: parsed.records });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /paused/);
  });

  it('accepts a loopback http endpoint only in local mode (D-035)', () => {
    const parsed = parseAgentRecords(
      { ...RAW, 'agent.endpoint': 'http://127.0.0.1:4021/v1/kev' },
      { allowLocalHttp: true },
    );
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    const strict = toProviderAgent({ ...BASE, records: parsed.records });
    assert.equal(strict.ok, false);
    if (!strict.ok) assert.match(strict.reason, /local mode/);
    const local = toProviderAgent({ ...BASE, records: parsed.records, allowLocalHttp: true });
    assert.ok(local.ok);
    if (local.ok) assert.equal(local.provider.endpoint, 'http://127.0.0.1:4021/v1/kev');
  });

  it('re-validates with the domain schema', () => {
    const parsed = parseAgentRecords(RAW);
    assert.ok(parsed.ok);
    if (!parsed.ok) return;
    // a label that is not a slug is refused by the zod ProviderAgent
    const r = toProviderAgent({ ...BASE, label: 'Not A Slug', records: parsed.records });
    assert.equal(r.ok, false);
  });
});
