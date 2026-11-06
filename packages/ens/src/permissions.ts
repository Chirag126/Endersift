/**
 * Permission-enforcement proof (plan row 13): the cases, and pure rules for
 * deciding whether to send each transaction and whether it passed.
 * Dependency-free; the script simulates, sends and reads.
 *
 * Every case is simulated first (eth_call at the latest block):
 *   - an `allow` case is sent only if the simulation succeeds;
 *   - a `deny` case is sent only if the simulation reverts with exactly
 *     EACUnauthorizedAccountRoles(resource(key), ROLE_SET_TEXT, operator), so
 *     the on-chain revert is recorded as evidence while a permission hole is
 *     never exercised for real (and deny cases write the CURRENT value, so even
 *     a hole would change nothing).
 */

export type Expectation = 'allow' | 'deny';

export type CaseId =
  | 'A_EDITS_A'
  | 'A_RESTORES_A'
  | 'A_EDITS_B'
  | 'A_EDITS_PAYTO'
  | 'ADMIN_REVOKES_A'
  | 'A_EDITS_A_AFTER_REVOKE'
  | 'ADMIN_RESTORES_A';

export interface CaseSpec {
  readonly id: CaseId;
  readonly expect: Expectation;
  readonly actor: 'operatorA' | 'admin';
  readonly title: string;
}

/** In execution order. Restores leave the deployment exactly as provisioned. */
export const PERMISSION_CASES: readonly CaseSpec[] = [
  {
    id: 'A_EDITS_A',
    expect: 'allow',
    actor: 'operatorA',
    title: 'operator A edits a delegated key on resolver A',
  },
  {
    id: 'A_RESTORES_A',
    expect: 'allow',
    actor: 'operatorA',
    title: 'operator A restores that key',
  },
  {
    id: 'A_EDITS_B',
    expect: 'deny',
    actor: 'operatorA',
    title: 'operator A edits the same key on resolver B',
  },
  {
    id: 'A_EDITS_PAYTO',
    expect: 'deny',
    actor: 'operatorA',
    title: 'operator A edits x402.payTo on resolver A',
  },
  {
    id: 'ADMIN_REVOKES_A',
    expect: 'allow',
    actor: 'admin',
    title: "admin revokes operator A's delegated keys",
  },
  {
    id: 'A_EDITS_A_AFTER_REVOKE',
    expect: 'deny',
    actor: 'operatorA',
    title: 'operator A edits resolver A after revocation',
  },
  {
    id: 'ADMIN_RESTORES_A',
    expect: 'allow',
    actor: 'admin',
    title: "admin re-grants operator A's delegated keys",
  },
];

/** Cases that only make sense after an earlier case ran on chain (not simulated in a dry run). */
export const NEEDS_PRIOR_TX: readonly CaseId[] = [
  'A_RESTORES_A',
  'A_EDITS_A_AFTER_REVOKE',
  'ADMIN_RESTORES_A',
];

export interface ExpectedDenial {
  readonly resource: bigint;
  readonly roleBitmap: bigint;
  readonly account: string;
}

export type Simulation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly errorName: string | null;
      readonly args: readonly unknown[] | null;
    };

interface SendNow {
  readonly send: true;
}
interface DoNotSend {
  readonly send: false;
  readonly reason: string;
}
export type SendDecision = SendNow | DoNotSend;

const sameAddress = (a: unknown, b: string): boolean =>
  typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/** The revert is exactly the access-control denial we expect (key, role and account). */
export function isExpectedDenial(sim: Simulation, expected: ExpectedDenial): boolean {
  if (sim.ok || sim.errorName !== 'EACUnauthorizedAccountRoles' || sim.args === null) return false;
  const [resource, roleBitmap, account] = sim.args;
  return (
    resource === expected.resource &&
    roleBitmap === expected.roleBitmap &&
    sameAddress(account, expected.account)
  );
}

export function decideSend(
  expect: Expectation,
  sim: Simulation,
  expected: ExpectedDenial | null,
): SendDecision {
  if (expect === 'allow') {
    return sim.ok
      ? { send: true }
      : {
          send: false,
          reason: `expected success but the simulation reverted (${sim.errorName ?? 'unknown error'})`,
        };
  }
  if (sim.ok) {
    return { send: false, reason: 'PERMISSION HOLE: the simulation succeeded; not sending' };
  }
  if (expected === null || !isExpectedDenial(sim, expected)) {
    return {
      send: false,
      reason: `reverted, but not with the expected EACUnauthorizedAccountRoles (${sim.errorName ?? 'unknown error'})`,
    };
  }
  return { send: true };
}

export interface CaseResult {
  readonly expect: Expectation;
  readonly simulation: Simulation;
  readonly expected: ExpectedDenial | null;
  /** Receipt status of the sent transaction, or null when nothing was sent. */
  readonly txStatus: 'success' | 'reverted' | null;
  /** A read-back after the transaction confirmed the intended effect (allow cases). */
  readonly effectVerified: boolean | null;
}

export interface Verdict {
  readonly pass: boolean;
  readonly reason: string;
}

/** `onchain`: the run sent transactions (--confirm); a dry run only proves the simulation. */
export function caseVerdict(r: CaseResult, onchain: boolean): Verdict {
  if (r.expect === 'allow') {
    if (!r.simulation.ok) return { pass: false, reason: 'simulation reverted' };
    if (!onchain) return { pass: true, reason: 'simulation succeeds (dry run)' };
    if (r.txStatus !== 'success')
      return { pass: false, reason: `transaction ${r.txStatus ?? 'not sent'}` };
    if (r.effectVerified !== true)
      return { pass: false, reason: 'read-back does not show the change' };
    return { pass: true, reason: 'transaction succeeded and the read-back matches' };
  }
  if (r.expected === null || !isExpectedDenial(r.simulation, r.expected)) {
    return {
      pass: false,
      reason: r.simulation.ok
        ? 'PERMISSION HOLE: simulation succeeded'
        : 'unexpected revert reason',
    };
  }
  if (!onchain)
    return { pass: true, reason: 'simulation reverts with EACUnauthorizedAccountRoles (dry run)' };
  if (r.txStatus !== 'reverted')
    return { pass: false, reason: `transaction ${r.txStatus ?? 'not sent'}` };
  return {
    pass: true,
    reason: 'reverted on chain; simulation decoded EACUnauthorizedAccountRoles',
  };
}

/** roles[resolverLabel][key | 'ROOT'] for one operator. */
export type RoleRow = Readonly<Record<string, bigint>>;
export type OperatorRoles = Readonly<Record<string, RoleRow>>;

/**
 * Problems with one operator's roles across every agent resolver: exactly
 * `role` on each operator key of its own resolver, nothing else anywhere.
 */
export function roleScopeProblems(input: {
  readonly ownLabel: string;
  readonly roles: OperatorRoles;
  readonly recordKeys: readonly string[];
  readonly operatorKeys: readonly string[];
  readonly role: bigint;
}): string[] {
  const problems: string[] = [];
  for (const [label, row] of Object.entries(input.roles)) {
    const own = label === input.ownLabel;
    if ((row['ROOT'] ?? 0n) !== 0n) problems.push(`${label}: root roles ${row['ROOT']}`);
    for (const key of input.recordKeys) {
      const have = row[key] ?? 0n;
      const want = own && input.operatorKeys.includes(key) ? input.role : 0n;
      if (have !== want) problems.push(`${label}/${key}: has ${have}, want ${want}`);
    }
  }
  return problems;
}

/** The test value written in A_EDITS_A: recognisable, valid, within the 500-char description cap. */
export function testDescription(original: string, stamp: string): string {
  const suffix = ` [operator edit test ${stamp}]`;
  return `${original.slice(0, 500 - suffix.length)}${suffix}`;
}
