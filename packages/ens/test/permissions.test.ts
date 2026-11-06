import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NEEDS_PRIOR_TX,
  PERMISSION_CASES,
  caseVerdict,
  decideSend,
  isExpectedDenial,
  roleScopeProblems,
  testDescription,
  type ExpectedDenial,
  type Simulation,
} from '../src/permissions.ts';

const OP = '0x4CEB63E87696133814B9122bDc057dd4B204b1EC';
const SET_TEXT = 1n << 4n;
const expected: ExpectedDenial = { resource: 123n, roleBitmap: SET_TEXT, account: OP };
const denied: Simulation = {
  ok: false,
  errorName: 'EACUnauthorizedAccountRoles',
  args: [123n, SET_TEXT, OP.toLowerCase()],
};
const ok: Simulation = { ok: true };

describe('permission cases', () => {
  it('cover the four cases of plan row 13, in an order that restores the deployment', () => {
    const ids = PERMISSION_CASES.map((c) => c.id);
    assert.deepEqual(ids, [
      'A_EDITS_A',
      'A_RESTORES_A',
      'A_EDITS_B',
      'A_EDITS_PAYTO',
      'ADMIN_REVOKES_A',
      'A_EDITS_A_AFTER_REVOKE',
      'ADMIN_RESTORES_A',
    ]);
    const expect = Object.fromEntries(PERMISSION_CASES.map((c) => [c.id, c.expect]));
    assert.equal(expect['A_EDITS_A'], 'allow');
    assert.equal(expect['A_EDITS_B'], 'deny');
    assert.equal(expect['A_EDITS_PAYTO'], 'deny');
    assert.equal(expect['ADMIN_REVOKES_A'], 'allow');
    assert.equal(expect['A_EDITS_A_AFTER_REVOKE'], 'deny');
    // every edit is undone, and every revoke re-granted
    assert.ok(ids.indexOf('A_RESTORES_A') > ids.indexOf('A_EDITS_A'));
    assert.equal(ids.at(-1), 'ADMIN_RESTORES_A');
    assert.ok(NEEDS_PRIOR_TX.includes('A_EDITS_A_AFTER_REVOKE'));
  });
});

describe('expected denial', () => {
  it('matches only EACUnauthorizedAccountRoles for the exact key, role and account', () => {
    assert.ok(isExpectedDenial(denied, expected));
    assert.ok(!isExpectedDenial(ok, expected));
    assert.ok(!isExpectedDenial({ ...denied, errorName: 'EACCannotGrantRoles' }, expected));
    assert.ok(!isExpectedDenial({ ...denied, args: [124n, SET_TEXT, OP] }, expected), 'other key');
    assert.ok(!isExpectedDenial({ ...denied, args: [123n, 1n, OP] }, expected), 'other role');
    assert.ok(
      !isExpectedDenial({ ...denied, args: [123n, SET_TEXT, '0x' + '1'.repeat(40)] }, expected),
    );
    assert.ok(!isExpectedDenial({ ok: false, errorName: null, args: null }, expected), 'undecoded');
  });
});

describe('decideSend', () => {
  it('sends an allowed case only when its simulation succeeds', () => {
    assert.deepEqual(decideSend('allow', ok, null), { send: true });
    assert.equal(decideSend('allow', denied, null).send, false);
  });

  it('never sends a denied case whose simulation succeeds (a permission hole)', () => {
    const d = decideSend('deny', ok, expected);
    assert.equal(d.send, false);
    assert.ok(!d.send && /PERMISSION HOLE/.test(d.reason));
  });

  it('sends a denied case only for the exact expected revert', () => {
    assert.deepEqual(decideSend('deny', denied, expected), { send: true });
    assert.equal(decideSend('deny', { ...denied, errorName: 'Other' }, expected).send, false);
    assert.equal(decideSend('deny', denied, null).send, false);
  });
});

describe('caseVerdict', () => {
  const allow = { expect: 'allow' as const, simulation: ok, expected: null };
  const deny = { expect: 'deny' as const, simulation: denied, expected };

  it('passes an allowed case on chain only with success and a matching read-back', () => {
    assert.ok(caseVerdict({ ...allow, txStatus: 'success', effectVerified: true }, true).pass);
    assert.ok(!caseVerdict({ ...allow, txStatus: 'success', effectVerified: false }, true).pass);
    assert.ok(!caseVerdict({ ...allow, txStatus: 'reverted', effectVerified: null }, true).pass);
    assert.ok(!caseVerdict({ ...allow, txStatus: null, effectVerified: null }, true).pass);
    assert.ok(
      caseVerdict({ ...allow, txStatus: null, effectVerified: null }, false).pass,
      'dry run',
    );
  });

  it('passes a denied case on chain only with a mined revert and the decoded denial', () => {
    assert.ok(caseVerdict({ ...deny, txStatus: 'reverted', effectVerified: null }, true).pass);
    assert.ok(!caseVerdict({ ...deny, txStatus: 'success', effectVerified: null }, true).pass);
    assert.ok(!caseVerdict({ ...deny, txStatus: null, effectVerified: null }, true).pass);
    const hole = caseVerdict(
      { ...deny, simulation: ok, txStatus: null, effectVerified: null },
      true,
    );
    assert.ok(!hole.pass && /PERMISSION HOLE/.test(hole.reason));
    assert.ok(
      caseVerdict({ ...deny, txStatus: null, effectVerified: null }, false).pass,
      'dry run',
    );
  });
});

describe('roleScopeProblems', () => {
  const keys = ['agent.endpoint', 'description', 'x402.payTo'];
  const opKeys = ['agent.endpoint', 'description'];
  const exact = {
    kev: { ROOT: 0n, 'agent.endpoint': SET_TEXT, description: SET_TEXT, 'x402.payTo': 0n },
    cve: { ROOT: 0n, 'agent.endpoint': 0n, description: 0n, 'x402.payTo': 0n },
  };
  const check = (roles: typeof exact) =>
    roleScopeProblems({
      ownLabel: 'kev',
      roles,
      recordKeys: keys,
      operatorKeys: opKeys,
      role: SET_TEXT,
    });

  it('accepts exactly SET_TEXT on the delegated keys of the own resolver', () => {
    assert.deepEqual(check(exact), []);
  });

  it('flags any role on another resolver, on a payout key, at root, or a missing grant', () => {
    assert.equal(check({ ...exact, cve: { ...exact.cve, description: SET_TEXT } }).length, 1);
    assert.equal(check({ ...exact, kev: { ...exact.kev, 'x402.payTo': SET_TEXT } }).length, 1);
    assert.equal(check({ ...exact, kev: { ...exact.kev, ROOT: 1n } }).length, 1);
    assert.equal(check({ ...exact, kev: { ...exact.kev, description: 0n } }).length, 1);
  });
});

describe('testDescription', () => {
  it('is recognisable, differs from the original and fits the 500-char cap', () => {
    const v = testDescription('CISA KEV', '20261027T010203Z');
    assert.equal(v, 'CISA KEV [operator edit test 20261027T010203Z]');
    assert.ok(testDescription('x'.repeat(600), '20261027T010203Z').length <= 500);
  });
});
