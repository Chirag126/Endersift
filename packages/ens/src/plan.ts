/**
 * Registration planner: given facts read from Sepolia and the local state
 * file, decide the single next action. Pure, so every branch is unit-tested;
 * the script only gathers facts and executes the step it is told.
 *
 * Order: deploy resolver → commit (the commitment includes the resolver) →
 * mint/approve MockUSDC while the commitment ages → wait → register → set
 * text records → done. Committing before funding overlaps the 60 s wait.
 */

export type StepKind =
  | 'LOW_ETH'
  | 'NAME_TAKEN'
  | 'PAYMENT_TOKEN_REJECTED'
  | 'DEPLOY_RESOLVER'
  | 'COMMIT'
  | 'COMMIT_PENDING'
  | 'MINT_USDC'
  | 'APPROVE_USDC'
  | 'WAIT_COMMITMENT'
  | 'REGISTER'
  | 'SET_TEXT'
  | 'DONE';

export interface RegistrationFacts {
  readonly ethBalance: bigint;
  readonly minEth: bigint;
  readonly available: boolean;
  readonly paymentTokenAccepted: boolean;
  /** base + premium in payment-token units. */
  readonly priceTotal: bigint;
  readonly usdcBalance: bigint;
  readonly allowance: bigint;
  /** Latest block timestamp (seconds). */
  readonly now: bigint;
  readonly minCommitmentAge: bigint;
  readonly maxCommitmentAge: bigint;
  /** commitmentAt() for our commitment; 0n when absent or not yet visible. */
  readonly committedAt: bigint;
  readonly desiredText: Readonly<Record<string, string>>;
  /** Current values as resolved through the Universal Resolver (null = unset). */
  readonly currentText: Readonly<Record<string, string | null>>;
}

export interface RegistrationState {
  readonly resolver: string | null;
  readonly commitment: string | null;
  readonly commitTx: string | null;
  readonly registerTx: string | null;
}

export interface NextStep {
  readonly kind: StepKind;
  readonly reason: string;
  /** For SET_TEXT: which key. For WAIT_COMMITMENT: seconds left. */
  readonly key?: string;
  readonly waitSeconds?: bigint;
}

const TERMINAL: readonly StepKind[] = ['LOW_ETH', 'NAME_TAKEN', 'PAYMENT_TOKEN_REJECTED', 'DONE'];
export const isTerminal = (k: StepKind): boolean => TERMINAL.includes(k);
/** Steps that send a transaction (and so need gas). */
export const SENDS_TX: readonly StepKind[] = [
  'DEPLOY_RESOLVER',
  'COMMIT',
  'MINT_USDC',
  'APPROVE_USDC',
  'REGISTER',
  'SET_TEXT',
];

function textStep(facts: RegistrationFacts): NextStep {
  for (const [key, value] of Object.entries(facts.desiredText)) {
    if (facts.currentText[key] !== value) {
      return { kind: 'SET_TEXT', key, reason: `text "${key}" is not yet the desired value` };
    }
  }
  return { kind: 'DONE', reason: 'registered; every desired text record resolves to its value' };
}

function rawNext(facts: RegistrationFacts, state: RegistrationState): NextStep {
  const registered = state.registerTx !== null;
  if (registered) {
    if (facts.available) {
      return {
        kind: 'REGISTER',
        reason: 'a register tx is recorded but the name reads as available; registering again',
      };
    }
    return textStep(facts);
  }
  if (!facts.available) {
    return {
      kind: 'NAME_TAKEN',
      reason: 'the name is not available and this machine never registered it',
    };
  }
  if (!facts.paymentTokenAccepted) {
    return {
      kind: 'PAYMENT_TOKEN_REJECTED',
      reason: 'the rent price oracle does not accept MockUSDC',
    };
  }
  if (state.resolver === null) {
    return { kind: 'DEPLOY_RESOLVER', reason: 'no resolver of our own yet' };
  }

  const age = facts.committedAt === 0n ? null : facts.now - facts.committedAt;
  if (state.commitment === null || (age !== null && age > facts.maxCommitmentAge)) {
    return {
      kind: 'COMMIT',
      reason:
        state.commitment === null
          ? 'no commitment yet'
          : 'the commitment expired; committing again',
    };
  }
  if (facts.committedAt === 0n) {
    return state.commitTx === null
      ? { kind: 'COMMIT', reason: 'commitment computed but never sent' }
      : { kind: 'COMMIT_PENDING', reason: 'commit tx sent; waiting for the chain to show it' };
  }

  if (facts.usdcBalance < facts.priceTotal) {
    return { kind: 'MINT_USDC', reason: 'MockUSDC balance is below the price' };
  }
  if (facts.allowance < facts.priceTotal) {
    return { kind: 'APPROVE_USDC', reason: 'registrar allowance is below the price' };
  }
  if (age !== null && age < facts.minCommitmentAge) {
    return {
      kind: 'WAIT_COMMITMENT',
      waitSeconds: facts.minCommitmentAge - age,
      reason: 'the commitment is younger than MIN_COMMITMENT_AGE',
    };
  }
  return { kind: 'REGISTER', reason: 'commitment aged, funded and approved' };
}

export function nextStep(facts: RegistrationFacts, state: RegistrationState): NextStep {
  const step = rawNext(facts, state);
  if (SENDS_TX.includes(step.kind) && facts.ethBalance < facts.minEth) {
    return {
      kind: 'LOW_ETH',
      reason: `Sepolia ETH below ${facts.minEth} wei; fund the wallet first`,
    };
  }
  return step;
}
