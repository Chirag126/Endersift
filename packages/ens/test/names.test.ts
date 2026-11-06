// Needs viem (installed in CI and on the owner's machine).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALL_RESOLVER_ROLES, RESOLVER_ROLES } from '../src/constants.ts';
import {
  EnsNameError,
  agentResolverSalt,
  dnsEncode,
  labelId,
  ownedResolverSalt,
  parseChildLabel,
  parseParentLabel,
  textKeyResource,
  userRegistrySalt,
} from '../src/names.ts';

describe('ENS name helpers', () => {
  it('extracts the label of a normalised second-level .eth name', () => {
    assert.deepEqual(parseParentLabel('myagents.eth'), { name: 'myagents.eth', label: 'myagents' });
  });

  it('rejects subnames, other TLDs, short labels and non-normalised input', () => {
    for (const bad of [
      'kev.myagents.eth',
      'myagents.xyz',
      'ab.eth',
      'MyAgents.eth',
      'eth',
      '.eth',
    ]) {
      assert.throws(() => parseParentLabel(bad), EnsNameError, bad);
    }
  });

  it('DNS-encodes names in wire format', () => {
    // 8 "myagents" 3 "eth" 0
    assert.equal(dnsEncode('myagents.eth'), '0x086d796167656e74730365746800');
  });

  it('derives a deterministic, owner-specific resolver salt', () => {
    const a = '0x' + '11'.repeat(20);
    const b = '0x' + '22'.repeat(20);
    assert.equal(ownedResolverSalt(a as `0x${string}`), ownedResolverSalt(a as `0x${string}`));
    assert.notEqual(ownedResolverSalt(a as `0x${string}`), ownedResolverSalt(b as `0x${string}`));
    assert.notEqual(
      ownedResolverSalt(a as `0x${string}`, 1n),
      ownedResolverSalt(a as `0x${string}`),
    );
  });

  it('grants every role and its admin counterpart', () => {
    for (const role of Object.values(RESOLVER_ROLES)) {
      assert.equal(ALL_RESOLVER_ROLES & role, role);
      assert.equal(ALL_RESOLVER_ROLES & (role << 128n), role << 128n);
    }
  });

  it('validates child labels', () => {
    assert.equal(parseChildLabel('kev'), 'kev');
    assert.equal(parseChildLabel('cve-2'), 'cve-2');
    for (const bad of ['k', 'Kev', 'kev.x', '-kev', 'kev-', 'k v', '']) {
      assert.throws(() => parseChildLabel(bad), EnsNameError, bad);
    }
  });

  it('computes label IDs as uint256(keccak256(label)) and distinct salts', () => {
    // keccak256("eth"), the well-known .eth labelhash
    assert.equal(
      labelId('eth'),
      0x4f5b812789fc606be1b3b16908db13fc7a9adf7ca72641f84d75b47069d3d7f0n,
    );
    assert.notEqual(userRegistrySalt('chirag126.eth'), agentResolverSalt('chirag126.eth'));
    assert.notEqual(agentResolverSalt('kev.chirag126.eth'), agentResolverSalt('cve.chirag126.eth'));
    assert.equal(userRegistrySalt('chirag126.eth'), userRegistrySalt('chirag126.eth'));
  });

  it('derives text-key role resources as uint256(keccak256(bytes(key)))', () => {
    // Known keccak-256 vectors: "" and "hello".
    assert.equal(
      textKeyResource(''),
      0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470n,
    );
    assert.equal(
      textKeyResource('hello'),
      0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8n,
    );
    assert.notEqual(textKeyResource('x402.payTo'), textKeyResource('agent.endpoint'));
    assert.notEqual(textKeyResource('agent.status'), 0n); // never the root resource
  });
});
