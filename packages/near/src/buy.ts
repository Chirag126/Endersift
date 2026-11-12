/**
 * The buyer's side of one paid request: ask, get a quote, check the quote
 * against the on-chain registry, run the counterparty check, pay through the
 * guard, ask again with the receipt, and return the data.
 *
 * The provider's answers are untrusted. The registry (owner-written, on
 * chain) is the reference: a quote whose payee, guard, network or price does
 * not match the registry entry is refused before the counterparty check.
 */
import type { Assessment } from './counterparty.ts';
import type { GuardPayResult, GuardProvider } from './guard.ts';
import { guardedPay, type GuardedPayDeps } from './guarded-pay.ts';
import {
  NEAR_PAYMENT_HEADER,
  parseQuote,
  paymentHeader,
  type NearNetwork,
  type NearQuote,
} from './pay-lane.ts';

export type HttpGet = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Promise<{ readonly status: number; readonly body: unknown }>;

export type BuyResult =
  | {
      readonly outcome: 'bought';
      readonly quote: NearQuote;
      readonly assessment: Assessment;
      readonly approvedByHuman: boolean;
      readonly payment: GuardPayResult;
      readonly receiptId: number;
      readonly data: unknown;
    }
  | {
      /** Nothing was signed. */
      readonly outcome: 'not-paid';
      readonly reason: string;
      readonly quote: NearQuote | null;
      readonly assessment: Assessment | null;
    }
  | {
      /** A signed call reached the chain and the contract refused it: nothing was paid. */
      readonly outcome: 'rejected';
      readonly reason: string;
      readonly quote: NearQuote;
      readonly assessment: Assessment;
      readonly payment: GuardPayResult;
    }
  | {
      /** The payment went out but the provider did not deliver. */
      readonly outcome: 'paid-not-delivered';
      readonly reason: string;
      readonly quote: NearQuote;
      readonly assessment: Assessment;
      readonly payment: GuardPayResult;
      readonly receiptId: number;
    };

export interface BuyDeps extends GuardedPayDeps {
  readonly get: HttpGet;
  readonly network: NearNetwork;
  readonly guardContractId: string;
  readonly now?: () => number;
}

export interface BuyRequest {
  readonly runId: string;
  /** The provider's registry entry, read from the guard contract. */
  readonly provider: GuardProvider;
  /** The full URL to buy; must be under the provider's registered endpoint. */
  readonly url: string;
  /** The most the agent planned to pay for this request (yoctoNEAR). */
  readonly maxAmount: bigint;
}

/** Why a quote cannot be trusted, or null when it matches the registry. */
export function quoteProblem(
  quote: NearQuote,
  request: BuyRequest,
  deps: Pick<BuyDeps, 'network' | 'guardContractId'>,
  nowMs: number,
): string | null {
  if (quote.network !== deps.network) return `the quote is for ${quote.network}`;
  if (quote.guard !== deps.guardContractId) return 'the quote names another guard contract';
  if (quote.payTo !== request.provider.accountId)
    return 'the quote pays an account that is not the registered provider';
  if (quote.amount > request.provider.price) return 'the quote is above the registered price';
  if (quote.amount > request.maxAmount) return 'the quote is above what the agent planned to pay';
  if (quote.amount <= 0n) return 'the quote has no price';
  if (Date.parse(quote.expiresAt) <= nowMs) return 'the quote expired';
  return null;
}

export async function buyFromProvider(deps: BuyDeps, request: BuyRequest): Promise<BuyResult> {
  const notPaid = (reason: string, quote: NearQuote | null = null): BuyResult => ({
    outcome: 'not-paid',
    reason,
    quote,
    assessment: null,
  });
  const base = request.provider.endpoint.replace(/\/+$/, '');
  if (request.url !== base && !request.url.startsWith(`${base}/`))
    return notPaid('the request is not under the registered endpoint');

  const first = await deps.get(request.url, {});
  if (first.status !== 402) return notPaid(`expected HTTP 402 with a quote, got ${first.status}`);
  let quote: NearQuote;
  try {
    quote = parseQuote(first.body);
  } catch (error) {
    return notPaid(error instanceof Error ? error.message : 'malformed quote');
  }
  const problem = quoteProblem(quote, request, deps, (deps.now ?? Date.now)());
  if (problem !== null) return notPaid(problem, quote);

  const paid = await guardedPay(deps, {
    runId: request.runId,
    receiver: quote.payTo,
    amount: quote.amount,
    memo: quote.nonce,
  });
  if (paid.outcome === 'refused' || paid.outcome === 'declined')
    return {
      outcome: 'not-paid',
      reason:
        paid.outcome === 'refused'
          ? 'the counterparty check blocked the receiver'
          : 'a human declined the warning',
      quote,
      assessment: paid.assessment,
    };
  if (paid.outcome === 'rejected' || paid.payment.receiptId === null)
    return {
      outcome: 'rejected',
      reason: paid.payment.failure ?? 'the guard contract returned no receipt',
      quote,
      assessment: paid.assessment,
      payment: paid.payment,
    };

  const receiptId = paid.payment.receiptId;
  const second = await deps.get(request.url, {
    [NEAR_PAYMENT_HEADER]: paymentHeader(quote.nonce, receiptId),
  });
  if (second.status !== 200)
    return {
      outcome: 'paid-not-delivered',
      reason: `the provider answered HTTP ${second.status} after payment`,
      quote,
      assessment: paid.assessment,
      payment: paid.payment,
      receiptId,
    };
  return {
    outcome: 'bought',
    quote,
    assessment: paid.assessment,
    approvedByHuman: paid.approvedByHuman,
    payment: paid.payment,
    receiptId,
    data: second.body,
  };
}
