/**
 * The counterparty check: before the agent signs a payment it asks about the
 * receiver and gets allow, warn or block, with the reasons.
 *
 * Signals and where each comes from (all read at check time, none cached):
 *
 *   exists, is a contract      NEAR RPC view_account (code_hash)
 *   code changed               view_account code_hash vs the hash the owner
 *                              pinned in the guard's registry
 *   account age, activity      NEAR RPC view_access_key_list: a key's nonce
 *                              starts at (block height when it was added) x
 *                              10^6 and goes up by one per transaction, so the
 *                              oldest key gives a lower bound on the account's
 *                              age and the nonces give a transaction count
 *   registered, price          the guard contract's registry
 *   blocklist with evidence    the guard contract's reports
 *   prior interactions         the guard contract's per-receiver statistics
 *                              (payments, passed and failed work checks)
 *
 * `assess` is pure and deterministic: the same facts give the same verdict.
 * The model never sees or influences it.
 */
import type { GuardProvider, GuardReader, GuardReceiverStats, GuardReport } from './guard.ts';
import type { NearRpc } from './rpc.ts';
import { formatNear } from './units.ts';

export type Verdict = 'allow' | 'warn' | 'block';

export interface Signal {
  /** Stable code, e.g. BLOCKLISTED. */
  readonly code: string;
  readonly level: Verdict;
  readonly detail: string;
}

export interface CounterpartyFacts {
  readonly receiver: string;
  /** What the agent is about to pay (yoctoNEAR). */
  readonly amount: bigint;
  readonly exists: boolean;
  /** Current contract code hash, or null (no contract). */
  readonly codeHash: string | null;
  readonly keyCount: number;
  /** Block height at which the oldest current key was added, or null (no keys). */
  readonly oldestKeyHeight: number | null;
  /** Transactions signed with the current keys. */
  readonly signedTransactions: number;
  readonly headHeight: number;
  /** The receiver's registry entry, or null (not registered). */
  readonly provider: GuardProvider | null;
  readonly reports: readonly GuardReport[];
  readonly stats: GuardReceiverStats;
}

export interface CounterpartyThresholds {
  /** A receiver younger than this many blocks, with no passed work yet, is a warning. */
  readonly minAgeBlocks: number;
}

export const DEFAULT_THRESHOLDS: CounterpartyThresholds = Object.freeze({
  // about a day at NEAR's block time of roughly one second
  minAgeBlocks: 86_400,
});

export interface Assessment {
  readonly receiver: string;
  readonly verdict: Verdict;
  readonly signals: readonly Signal[];
}

const RANK: Readonly<Record<Verdict, number>> = { allow: 0, warn: 1, block: 2 };

/** A key's nonce starts at height x 10^6 (nomicon: access keys). */
const NONCE_PER_BLOCK = 1_000_000n;

export function keyHeight(nonce: bigint): number {
  return Number(nonce / NONCE_PER_BLOCK);
}

export function keyTransactions(nonce: bigint): number {
  return Number(nonce % NONCE_PER_BLOCK);
}

export function assess(
  facts: CounterpartyFacts,
  thresholds: CounterpartyThresholds = DEFAULT_THRESHOLDS,
): Assessment {
  const signals: Signal[] = [];
  const add = (code: string, level: Verdict, detail: string) =>
    signals.push({ code, level, detail });

  if (!facts.exists) add('NO_ACCOUNT', 'block', 'the receiver account does not exist');

  if (facts.reports.length > 0) {
    const first = facts.reports[0];
    add(
      'BLOCKLISTED',
      'block',
      `${facts.reports.length} report(s) on the shared blocklist` +
        (first === undefined
          ? ''
          : `; first by ${first.reporter}: ${first.reason}` +
            (first.evidence === '' ? '' : ` (evidence: ${first.evidence})`)),
    );
  }

  if (facts.provider === null) {
    add('NOT_REGISTERED', 'block', 'the receiver is not in the provider registry');
  } else {
    if (facts.amount > facts.provider.price)
      add(
        'ABOVE_PRICE',
        'block',
        `${formatNear(facts.amount)} NEAR is above the registered price of ${formatNear(facts.provider.price)} NEAR`,
      );
    if (facts.exists && facts.codeHash !== facts.provider.codeHash)
      add(
        'CODE_CHANGED',
        'warn',
        facts.provider.codeHash === null
          ? 'the receiver had no contract when it was registered and has one now'
          : facts.codeHash === null
            ? 'the receiver had a contract when it was registered and has none now'
            : 'the receiver contract code changed since it was registered',
      );
  }

  if (facts.exists) {
    if (facts.codeHash !== null) add('IS_CONTRACT', 'allow', 'the receiver is a contract account');
    if (facts.oldestKeyHeight === null) {
      add(
        'AGE_UNKNOWN',
        'allow',
        'the receiver has no access keys, so its age cannot be estimated',
      );
    } else {
      const age = Math.max(0, facts.headHeight - facts.oldestKeyHeight);
      const young = age < thresholds.minAgeBlocks;
      add(
        young ? 'YOUNG_ACCOUNT' : 'ACCOUNT_AGE',
        young && facts.stats.passed === 0 ? 'warn' : 'allow',
        `the receiver has held a key for about ${age} blocks and signed ${facts.signedTransactions} transaction(s)` +
          (young ? ` (under the ${thresholds.minAgeBlocks}-block minimum)` : ''),
      );
    }
  }

  if (facts.stats.failed > 0 && facts.stats.failed >= facts.stats.passed)
    add(
      'FAILED_BEFORE',
      'warn',
      `work from this receiver failed the agent's check ${facts.stats.failed} time(s) and passed ${facts.stats.passed}`,
    );
  add(
    facts.stats.payments === 0 ? 'FIRST_PAYMENT' : 'PAID_BEFORE',
    'allow',
    facts.stats.payments === 0
      ? 'the agent has not paid this receiver before'
      : `the agent paid this receiver ${facts.stats.payments} time(s), ${formatNear(facts.stats.total)} NEAR in total; ${facts.stats.passed} delivery check(s) passed`,
  );

  const verdict = signals.reduce<Verdict>(
    (worst, s) => (RANK[s.level] > RANK[worst] ? s.level : worst),
    'allow',
  );
  return { receiver: facts.receiver, verdict, signals };
}

/** Read every fact about a receiver from the NEAR RPC and the guard contract. */
export async function collectFacts(
  rpc: NearRpc,
  guard: GuardReader,
  receiver: string,
  amount: bigint,
): Promise<CounterpartyFacts> {
  const [account, keys, head, provider, reports, stats] = await Promise.all([
    rpc.viewAccount(receiver),
    rpc.accessKeys(receiver),
    rpc.head(),
    guard.provider(receiver),
    guard.reports(receiver),
    guard.receiverStats(receiver),
  ]);
  const heights = keys.map((k) => keyHeight(k.nonce));
  return {
    receiver,
    amount,
    exists: account !== null,
    codeHash: account?.codeHash ?? null,
    keyCount: keys.length,
    oldestKeyHeight: heights.length === 0 ? null : Math.min(...heights),
    signedTransactions: keys.reduce((n, k) => n + keyTransactions(k.nonce), 0),
    headHeight: head.height,
    provider,
    reports,
    stats,
  };
}

/** Collect the facts and assess them. */
export async function checkCounterparty(
  rpc: NearRpc,
  guard: GuardReader,
  receiver: string,
  amount: bigint,
  thresholds: CounterpartyThresholds = DEFAULT_THRESHOLDS,
): Promise<Assessment> {
  return assess(await collectFacts(rpc, guard, receiver, amount), thresholds);
}
