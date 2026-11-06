import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  nextProvisionStep,
  recordsToWrite,
  roleDiff,
  type AgentFacts,
  type ProvisionFacts,
} from '../src/plan-provision.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const ETH_REGISTRY = '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4';
const REGISTRY = '0x3F54Fcd9ea71D96db6e66aaecCB5B20c3C003758';
const OTHER = '0x1111111111111111111111111111111111111111';
const OPERATOR = '0x2222222222222222222222222222222222222222';
const SET_TEXT = 1n << 4n;
const KEYS = ['agent.endpoint', 'agent.status', 'x402.payTo', 'description'];
const OPERATOR_KEYS = ['agent.endpoint', 'agent.status', 'description'];
const DESIRED = {
  'agent.endpoint': 'http://127.0.0.1:4021/v1/kev',
  'agent.status': 'active',
  'x402.payTo': '0.0.11044329',
  description: 'KEV',
};
const NOW = 1_800_000_000n;

const agent = (patch: Partial<AgentFacts> = {}): AgentFacts => ({
  label: 'kev',
  resolver: '0x1993BB58708a630AF1CC01304Dd851BDEccF9261',
  resolverDeployed: true,
  adminControlsResolver: true,
  subExpiry: NOW + 1000n,
  resolverOnChain: '0x1993bb58708a630af1cc01304dd851bdeccf9261',
  currentText: { ...DESIRED },
  desiredText: DESIRED,
  operator: OPERATOR,
  operatorRoles: Object.fromEntries(OPERATOR_KEYS.map((k) => [k, SET_TEXT])),
  operatorRootRoles: 0n,
  ...patch,
});

const facts = (patch: Partial<ProvisionFacts> = {}): ProvisionFacts => ({
  ethBalance: 10n ** 17n,
  minEth: 10n ** 16n,
  now: NOW,
  parentLabel: 'chirag126',
  ethRegistry: ETH_REGISTRY,
  parentExpiry: NOW + 10_000n,
  parentSubregistry: REGISTRY.toLowerCase(),
  registry: REGISTRY,
  registryDeployed: true,
  adminControlsRegistry: true,
  registryParent: { parent: ETH_REGISTRY, label: 'chirag126' },
  recordKeys: KEYS,
  operatorKeys: OPERATOR_KEYS,
  operatorRole: SET_TEXT,
  agents: [agent()],
  ...patch,
});

const kind = (f: ProvisionFacts) => nextProvisionStep(f).kind;

describe('provision planner', () => {
  it('reports DONE with nothing to send when everything converged (rerun = no-op)', () => {
    const step = nextProvisionStep(facts());
    assert.equal(step.kind, 'DONE');
    // even with no ETH: a converged deployment needs no transaction
    assert.equal(kind(facts({ ethBalance: 0n })), 'DONE');
  });

  it('builds the subregistry path in order from an empty chain', () => {
    const empty = facts({
      parentSubregistry: ZERO,
      registryDeployed: false,
      adminControlsRegistry: false,
      registryParent: null,
      agents: [
        agent({
          resolverDeployed: false,
          adminControlsResolver: false,
          subExpiry: 0n,
          resolverOnChain: ZERO,
          currentText: {},
          operator: null,
          operatorRoles: {},
        }),
      ],
    });
    assert.equal(kind(empty), 'DEPLOY_REGISTRY');
    const deployed = { ...empty, registryDeployed: true, adminControlsRegistry: true };
    assert.equal(kind(deployed), 'SET_SUBREGISTRY');
    const linked = { ...deployed, parentSubregistry: REGISTRY };
    assert.equal(kind(linked), 'SET_PARENT');
    const canonical = { ...linked, registryParent: { parent: ETH_REGISTRY, label: 'chirag126' } };
    assert.equal(kind(canonical), 'DEPLOY_RESOLVER');
  });

  it('walks one agent: resolver → register → pointer → records → roles', () => {
    assert.equal(kind(facts({ agents: [agent({ resolverDeployed: false })] })), 'DEPLOY_RESOLVER');
    assert.equal(kind(facts({ agents: [agent({ subExpiry: 0n })] })), 'REGISTER_SUBNAME');
    assert.equal(kind(facts({ agents: [agent({ subExpiry: NOW })] })), 'REGISTER_SUBNAME'); // expired
    assert.equal(kind(facts({ agents: [agent({ resolverOnChain: OTHER })] })), 'SET_RESOLVER');
    const records = nextProvisionStep(
      facts({ agents: [agent({ currentText: { description: 'old' } })] }),
    );
    assert.equal(records.kind, 'SET_RECORDS');
    assert.deepEqual(records.keys, ['agent.endpoint', 'agent.status', 'x402.payTo', 'description']);
    const grant = nextProvisionStep(facts({ agents: [agent({ operatorRoles: {} })] }));
    assert.equal(grant.kind, 'GRANT_ROLES');
    assert.deepEqual(
      grant.changes?.map((c) => c.key),
      OPERATOR_KEYS,
    );
  });

  it('adopts the existing kev setup and only writes what differs', () => {
    // kev today: registered with its own resolver, only description + url set, no operator yet.
    const kevToday = agent({
      currentText: { description: 'Provider agent "kev" …' },
      operator: null,
      operatorRoles: {},
    });
    const step = nextProvisionStep(facts({ agents: [kevToday] }));
    assert.equal(step.kind, 'SET_RECORDS');
    assert.equal(step.agent, 'kev');
  });

  it('moves to the next agent only when the previous one is complete', () => {
    const cve = agent({ label: 'cve', resolverDeployed: false });
    const step = nextProvisionStep(facts({ agents: [agent(), cve] }));
    assert.equal(step.kind, 'DEPLOY_RESOLVER');
    assert.equal(step.agent, 'cve');
  });

  it('revokes excess roles before granting missing ones', () => {
    const step = nextProvisionStep(
      facts({
        agents: [agent({ operatorRoles: { 'x402.payTo': SET_TEXT }, operatorRootRoles: 1n })],
      }),
    );
    assert.equal(step.kind, 'REVOKE_ROLES');
    assert.deepEqual(step.changes, [
      { key: null, bits: 1n },
      { key: 'x402.payTo', bits: SET_TEXT },
    ]);
  });

  it('refuses to touch a subregistry or resolver it does not control', () => {
    assert.equal(kind(facts({ parentSubregistry: OTHER })), 'FOREIGN_SUBREGISTRY');
    assert.equal(kind(facts({ adminControlsRegistry: false })), 'FOREIGN_SUBREGISTRY');
    assert.equal(
      kind(facts({ agents: [agent({ adminControlsResolver: false })] })),
      'FOREIGN_RESOLVER',
    );
  });

  it('stops on an unregistered parent, and on low ETH only when a transaction is due', () => {
    assert.equal(kind(facts({ parentExpiry: 0n })), 'PARENT_NOT_REGISTERED');
    assert.equal(kind(facts({ ethBalance: 0n, agents: [agent({ subExpiry: 0n })] })), 'LOW_ETH');
  });
});

describe('record and role diffs', () => {
  it('writes differing keys and clears keys that must be empty', () => {
    assert.deepEqual(
      recordsToWrite(['a', 'b', 'c'], { a: '1', b: 'stale', c: '' }, { a: '1', c: '' }),
      ['b'],
    );
    assert.deepEqual(recordsToWrite(['a'], {}, { a: 'x' }), ['a']);
    assert.deepEqual(recordsToWrite(['a'], { a: 'x' }, { a: 'x' }), []);
  });

  it('wants SET_TEXT on operator keys only, and strips extra bits on them', () => {
    const f = { recordKeys: KEYS, operatorKeys: OPERATOR_KEYS, operatorRole: SET_TEXT };
    const extra = SET_TEXT | (SET_TEXT << 128n); // SET_TEXT plus its admin role
    const { revoke, grant } = roleDiff(f, {
      operatorRoles: { 'agent.endpoint': extra, 'agent.status': SET_TEXT },
      operatorRootRoles: 0n,
    });
    assert.deepEqual(revoke, [{ key: 'agent.endpoint', bits: SET_TEXT << 128n }]);
    assert.deepEqual(grant, [{ key: 'description', bits: SET_TEXT }]);
  });
});
