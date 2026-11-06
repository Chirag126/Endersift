import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isTerminal,
  nextStep,
  type RegistrationFacts,
  type RegistrationState,
} from '../src/plan.ts';

const FACTS: RegistrationFacts = {
  ethBalance: 10n ** 17n,
  minEth: 10n ** 16n,
  available: true,
  paymentTokenAccepted: true,
  priceTotal: 8_000_021n,
  usdcBalance: 0n,
  allowance: 0n,
  now: 1_000_000n,
  minCommitmentAge: 60n,
  maxCommitmentAge: 86_400n,
  committedAt: 0n,
  desiredText: { description: 'd', url: 'u' },
  currentText: {},
};
const FRESH: RegistrationState = {
  resolver: null,
  commitment: null,
  commitTx: null,
  registerTx: null,
};
const RESOLVER = '0x' + '11'.repeat(20);
const COMMITMENT = '0x' + 'ab'.repeat(32);

const kind = (f: Partial<RegistrationFacts>, s: Partial<RegistrationState>) =>
  nextStep({ ...FACTS, ...f }, { ...FRESH, ...s }).kind;

describe('registration planner', () => {
  it('walks the happy path in order', () => {
    assert.equal(kind({}, {}), 'DEPLOY_RESOLVER');
    assert.equal(kind({}, { resolver: RESOLVER }), 'COMMIT');
    const committed = { resolver: RESOLVER, commitment: COMMITMENT, commitTx: '0x01' };
    assert.equal(kind({ committedAt: 999_990n }, committed), 'MINT_USDC');
    assert.equal(
      kind({ committedAt: 999_990n, usdcBalance: 8_000_021n }, committed),
      'APPROVE_USDC',
    );
    const funded = { usdcBalance: 8_000_021n, allowance: 8_000_021n };
    const young = nextStep(
      { ...FACTS, ...funded, committedAt: 999_990n },
      { ...FRESH, ...committed },
    );
    assert.equal(young.kind, 'WAIT_COMMITMENT');
    assert.equal(young.waitSeconds, 50n);
    assert.equal(kind({ ...funded, committedAt: 999_900n }, committed), 'REGISTER');
    const registered = { ...committed, registerTx: '0x02' };
    const first = nextStep(
      { ...FACTS, available: false, currentText: {} },
      { ...FRESH, ...registered },
    );
    assert.equal(first.kind, 'SET_TEXT');
    assert.equal(first.key, 'description');
    assert.equal(
      kind({ available: false, currentText: { description: 'd', url: null } }, registered),
      'SET_TEXT',
    );
    assert.equal(
      kind({ available: false, currentText: { description: 'd', url: 'u' } }, registered),
      'DONE',
    );
  });

  it('accepts a commitment exactly at MIN_COMMITMENT_AGE', () => {
    const s = { resolver: RESOLVER, commitment: COMMITMENT, commitTx: '0x01' };
    const funded = { usdcBalance: 8_000_021n, allowance: 8_000_021n };
    assert.equal(kind({ ...funded, committedAt: 1_000_000n - 60n }, s), 'REGISTER');
  });

  it('re-commits an expired commitment and waits for a pending one', () => {
    const s = { resolver: RESOLVER, commitment: COMMITMENT, commitTx: '0x01' };
    assert.equal(kind({ committedAt: 1_000_000n - 86_401n }, s), 'COMMIT');
    assert.equal(kind({ committedAt: 0n }, s), 'COMMIT_PENDING');
    assert.equal(kind({ committedAt: 0n }, { ...s, commitTx: null }), 'COMMIT');
  });

  it('stops on a taken name, a rejected payment token, or low ETH', () => {
    assert.equal(kind({ available: false }, {}), 'NAME_TAKEN');
    assert.equal(kind({ paymentTokenAccepted: false }, {}), 'PAYMENT_TOKEN_REJECTED');
    assert.equal(kind({ ethBalance: 1n }, {}), 'LOW_ETH');
    // Low ETH does not block steps that send nothing.
    const s = { resolver: RESOLVER, commitment: COMMITMENT, commitTx: '0x01' };
    assert.equal(kind({ ethBalance: 1n, committedAt: 0n }, s), 'COMMIT_PENDING');
    assert.equal(
      kind(
        { ethBalance: 1n, available: false, currentText: { description: 'd', url: 'u' } },
        { ...s, registerTx: '0x02' },
      ),
      'DONE',
    );
  });

  it('marks terminal steps', () => {
    for (const k of ['DONE', 'NAME_TAKEN', 'LOW_ETH', 'PAYMENT_TOKEN_REJECTED'] as const)
      assert.ok(isTerminal(k));
    assert.ok(!isTerminal('REGISTER'));
  });
});
