import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isSubnameTerminal,
  nextSubnameStep,
  type SubnameFacts,
  type SubnameState,
} from '../src/plan-subname.ts';

const ZERO = '0x0000000000000000000000000000000000000000';
const ETH_REGISTRY = '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4';
const REG = '0x' + 'aa'.repeat(20);
const RES = '0x' + 'bb'.repeat(20);
const FACTS: SubnameFacts = {
  ethBalance: 10n ** 17n,
  minEth: 5n * 10n ** 15n,
  now: 1_000n,
  parentExpiry: 10_000n,
  parentSubregistry: ZERO,
  ethRegistry: ETH_REGISTRY,
  parentLabel: 'chirag126',
  registryParent: null,
  subExpiry: 0n,
  subResolverOnChain: ZERO,
  desiredText: { description: 'd', url: 'u' },
  currentText: {},
};
const EMPTY: SubnameState = { registry: null, subResolver: null };
const kind = (f: Partial<SubnameFacts>, s: Partial<SubnameState> = {}) =>
  nextSubnameStep({ ...FACTS, ...f }, { ...EMPTY, ...s }).kind;

describe('subname planner', () => {
  it('walks the happy path in order', () => {
    assert.equal(kind({}), 'DEPLOY_REGISTRY');
    assert.equal(kind({}, { registry: REG }), 'SET_SUBREGISTRY');
    const linked = { parentSubregistry: REG.toUpperCase().replace('0X', '0x') };
    assert.equal(
      kind({ ...linked, registryParent: { parent: ZERO, label: '' } }, { registry: REG }),
      'SET_PARENT',
    );
    const parented = { ...linked, registryParent: { parent: ETH_REGISTRY, label: 'chirag126' } };
    assert.equal(kind(parented, { registry: REG }), 'DEPLOY_SUB_RESOLVER');
    assert.equal(kind(parented, { registry: REG, subResolver: RES }), 'REGISTER_SUBNAME');
    const registered = { ...parented, subExpiry: 10_000n, subResolverOnChain: RES };
    const s = { registry: REG, subResolver: RES };
    const t = nextSubnameStep({ ...FACTS, ...registered }, { ...EMPTY, ...s });
    assert.equal(t.kind, 'SET_TEXT');
    assert.equal(t.key, 'description');
    assert.equal(kind({ ...registered, currentText: { description: 'd', url: 'u' } }, s), 'DONE');
  });

  it('repairs a wrong parent label or a resolver that points elsewhere', () => {
    const base = {
      parentSubregistry: REG,
      registryParent: { parent: ETH_REGISTRY, label: 'other' },
    };
    assert.equal(kind(base, { registry: REG }), 'SET_PARENT');
    const good = {
      parentSubregistry: REG,
      registryParent: { parent: ETH_REGISTRY, label: 'chirag126' },
    };
    assert.equal(
      kind(
        { ...good, subExpiry: 10_000n, subResolverOnChain: '0x' + 'cc'.repeat(20) },
        { registry: REG, subResolver: RES },
      ),
      'SET_SUB_RESOLVER',
    );
  });

  it('re-registers an expired subname', () => {
    const good = {
      parentSubregistry: REG,
      registryParent: { parent: ETH_REGISTRY, label: 'chirag126' },
    };
    assert.equal(
      kind({ ...good, subExpiry: 999n }, { registry: REG, subResolver: RES }),
      'REGISTER_SUBNAME',
    );
  });

  it('stops without overwriting a foreign subregistry, an unregistered parent, or low ETH', () => {
    assert.equal(kind({ parentSubregistry: '0x' + 'dd'.repeat(20) }), 'SUBREGISTRY_EXISTS');
    assert.equal(kind({ parentExpiry: 1_000n }), 'PARENT_NOT_REGISTERED');
    assert.equal(kind({ ethBalance: 0n }), 'LOW_ETH');
    for (const k of ['DONE', 'LOW_ETH', 'SUBREGISTRY_EXISTS', 'PARENT_NOT_REGISTERED'] as const) {
      assert.ok(isSubnameTerminal(k));
    }
  });
});
