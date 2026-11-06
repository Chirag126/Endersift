/**
 * Which money paid for a Router call: 0G credits or the on-chain deposit.
 *
 * The Router's usage-history entries carry `credit_used` and `deposit_used`
 * (neuron), seen live on 2026-10-26 (docs/evidence/zg/inference-20261026T143405Z.json:
 * credit_used "0", deposit_used = cost). This is the evidence for "credits
 * spent" (G1): a call counts as credit-funded only when credit_used > 0.
 */
import { isRecord } from './http.ts';
import { parseNeuron } from './units.ts';

export type FundingSource = 'credits' | 'deposit' | 'mixed' | 'none';

export interface CallFunding {
  readonly creditUsed: bigint;
  readonly depositUsed: bigint;
  readonly source: FundingSource;
}

/** Funding split of one usage-history entry, or null if the entry lacks the fields. */
export function parseCallFunding(entry: unknown): CallFunding | null {
  if (!isRecord(entry)) return null;
  if (!('credit_used' in entry) || !('deposit_used' in entry)) return null;
  try {
    const creditUsed = parseNeuron(entry['credit_used'], 'credit_used').neuron;
    const depositUsed = parseNeuron(entry['deposit_used'], 'deposit_used').neuron;
    const source: FundingSource =
      creditUsed > 0n && depositUsed > 0n
        ? 'mixed'
        : creditUsed > 0n
          ? 'credits'
          : depositUsed > 0n
            ? 'deposit'
            : 'none';
    return { creditUsed, depositUsed, source };
  } catch {
    return null;
  }
}

/** Human label for the final verdict line. */
export function fundingLabel(funding: CallFunding | null): string {
  if (funding === null) return 'funding source unknown (no usage-history entry)';
  switch (funding.source) {
    case 'credits':
      return 'funded by 0G CREDITS';
    case 'mixed':
      return 'funded partly by 0G credits, partly by deposit';
    case 'deposit':
      return 'funded by DEPOSIT (no credits used)';
    case 'none':
      return 'no charge recorded in usage history';
  }
}
