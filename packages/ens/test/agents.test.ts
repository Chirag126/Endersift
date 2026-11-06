import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENTS,
  AgentManifestError,
  agentEndpoint,
  desiredAgentText,
  missingPayoutLabels,
  type AgentDeploymentInputs,
} from '../src/agents.ts';
import { AGENT_RECORD_SPEC, parseAgentRecords } from '../src/records.ts';

const inputs = (patch: Partial<AgentDeploymentInputs> = {}): AgentDeploymentInputs => ({
  endpointBase: 'http://127.0.0.1:4021',
  payToByLabel: new Map([
    ['kev', '0.0.11044329'],
    ['cve', '0.0.11044330'],
    ['osv', '0.0.11044331'],
  ]),
  network: 'hedera:testnet',
  asset: '0.0.0',
  maxPriceAtomic: 1_000_000n,
  ...patch,
});

describe('agent manifest', () => {
  it('defines three distinct agents matching the Hedera provider labels', () => {
    assert.deepEqual(
      AGENTS.map((a) => a.label),
      ['kev', 'cve', 'osv'],
    );
    const caps = AGENTS.flatMap((a) => a.capabilities);
    assert.equal(new Set(caps).size, caps.length, 'capabilities are unique across agents');
  });

  it('produces a complete, schema-valid record set for every agent', () => {
    for (const def of AGENTS) {
      const text = desiredAgentText(def, inputs());
      for (const s of AGENT_RECORD_SPEC)
        assert.ok((text[s.key] ?? '') !== '', `${def.label}: ${s.key}`);
      const parsed = parseAgentRecords(text, {
        allowLocalHttp: true,
        expectedNetwork: 'hedera:testnet',
      });
      assert.ok(parsed.ok, def.label);
      assert.equal(text['agent-endpoint[x402]'], text['agent.endpoint']);
    }
  });

  it('takes payTo from the env by label, never from the manifest', () => {
    const kev = AGENTS[0];
    assert.ok(kev !== undefined);
    assert.equal(desiredAgentText(kev, inputs())['x402.payTo'], '0.0.11044329');
    assert.throws(
      () => desiredAgentText(kev, inputs({ payToByLabel: new Map() })),
      AgentManifestError,
    );
    assert.deepEqual(missingPayoutLabels(new Map([['kev', '0.0.1']])), ['cve', 'osv']);
  });

  it('refuses a price above the payer cap', () => {
    const kev = AGENTS[0];
    assert.ok(kev !== undefined);
    assert.throws(
      () => desiredAgentText(kev, inputs({ maxPriceAtomic: 1n })),
      /X402_MAX_PAYMENT_TINYBARS/,
    );
  });

  it('builds endpoints under /v1/<label> and switches to https by config alone', () => {
    assert.equal(agentEndpoint('http://127.0.0.1:4021/', 'kev'), 'http://127.0.0.1:4021/v1/kev');
    assert.equal(
      agentEndpoint('https://api.example.onrender.com', 'osv'),
      'https://api.example.onrender.com/v1/osv',
    );
    assert.throws(() => agentEndpoint('https://x.example/?a=1', 'kev'), AgentManifestError);
    assert.throws(() => agentEndpoint('not a url', 'kev'), AgentManifestError);
    // a public http endpoint is refused by the record parser
    const kev = AGENTS[0];
    assert.ok(kev !== undefined);
    assert.throws(
      () => desiredAgentText(kev, inputs({ endpointBase: 'http://evil.example' })),
      /refusing to serialise/,
    );
  });
});
