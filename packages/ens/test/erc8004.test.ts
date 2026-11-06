// Class: unit. ERC-8004 identity (D-066): the registration file and the
// deployment record are read and written exactly as the spec and the
// IdentityRegistry contract define them. No network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ERC8004_SEPOLIA,
  serializeErc8004Deployment,
  REGISTRATION_TYPE,
  agentRegistryId,
  identityRegistryAbi,
  parseErc8004Deployment,
  registrationFile,
} from '../src/erc8004.ts';

const AGENT = {
  agentId: '42',
  agentURI: 'https://providers.example/.well-known/erc-8004/kev.json',
  owner: '0x66359fa8d11365B71bCB9e7324Bf73c5487a77F5',
};
const RECORD = { kind: 'erc8004-deployment', version: 1 };

describe('ERC-8004 identity', () => {
  it('names the registry as eip155:<chain>:<address>, the Sepolia deployment from the official repo', () => {
    assert.equal(
      agentRegistryId(ERC8004_SEPOLIA.chainId, ERC8004_SEPOLIA.identityRegistry),
      'eip155:11155111:0x8004A818BFB912233c491871b3d84c89A494BD9e',
    );
    const fns = identityRegistryAbi.filter((x) => x.type === 'function').map((x) => x.name);
    assert.deepEqual(fns, ['register', 'setAgentURI', 'tokenURI', 'ownerOf']);
  });

  it('a registration file lists its on-chain ID only once there is one', () => {
    const base = {
      name: 'kev.chirag126.eth',
      description: 'CISA KEV.',
      services: [{ name: 'ENS', endpoint: 'kev.chirag126.eth' }],
      x402Support: true,
      chainId: ERC8004_SEPOLIA.chainId,
      identityRegistry: ERC8004_SEPOLIA.identityRegistry,
    };
    const unregistered = registrationFile({ ...base, agentId: null });
    assert.equal(unregistered.type, REGISTRATION_TYPE);
    assert.deepEqual(unregistered.registrations, []);
    assert.equal(unregistered.active, true);
    assert.ok(!('supportedTrust' in unregistered), 'no trust model is claimed');
    const registered = registrationFile({ ...base, agentId: '42' });
    assert.deepEqual(registered.registrations, [
      { agentId: 42, agentRegistry: 'eip155:11155111:0x8004A818BFB912233c491871b3d84c89A494BD9e' },
    ]);
  });

  it('serialises the record stably: label order and extra fields do not change the bytes', () => {
    const a = serializeErc8004Deployment({
      kind: 'erc8004-deployment',
      version: 1,
      chainId: 11155111,
      identityRegistry: ERC8004_SEPOLIA.identityRegistry,
      agents: { osv: { ...AGENT, agentId: '43' }, kev: AGENT },
    });
    const b = serializeErc8004Deployment({
      kind: 'erc8004-deployment',
      version: 1,
      chainId: 11155111,
      identityRegistry: ERC8004_SEPOLIA.identityRegistry,
      agents: { kev: AGENT, osv: { ...AGENT, agentId: '43' } },
    });
    assert.equal(a, b);
    assert.ok(a.endsWith('\n') && !a.includes('registerTx'));
  });

  it('reads the deployment record defensively', () => {
    const ok = parseErc8004Deployment({
      ...RECORD,
      chainId: 11155111,
      identityRegistry: ERC8004_SEPOLIA.identityRegistry,
      agents: { kev: AGENT },
    });
    assert.equal(ok?.agents['kev']?.agentId, '42');
    const reg = ERC8004_SEPOLIA.identityRegistry;
    for (const bad of [
      null,
      { chainId: 1, identityRegistry: reg, agents: {} },
      { ...RECORD, chainId: '1', identityRegistry: reg, agents: {} },
      { ...RECORD, chainId: 1, identityRegistry: 'nope', agents: {} },
      {
        ...RECORD,
        chainId: 1,
        identityRegistry: reg,
        agents: { kev: { ...AGENT, agentId: '-1' } },
      },
      { ...RECORD, chainId: 1, identityRegistry: reg, agents: { KEV: AGENT } },
      { ...RECORD, chainId: 1, identityRegistry: reg, agents: { kev: { ...AGENT, owner: '0x1' } } },
    ])
      assert.equal(parseErc8004Deployment(bad), null, JSON.stringify(bad));
  });
});
