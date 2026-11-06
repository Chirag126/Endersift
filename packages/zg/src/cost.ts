/**
 * Deterministic inference cost control, evaluated BEFORE a call is sent.
 *
 * The worst case is computed from the live catalog price and an upper bound
 * on tokens: byte-level BPE tokenizers never produce more tokens than UTF-8
 * bytes, so prompt bytes plus a fixed per-message overhead bound the prompt,
 * and max_tokens bounds the completion. The decision depends only on
 * configuration and catalog data, never on model output (same principle as
 * the Hedera payment guard, D-017).
 */
import type { ZgBilling, ZgMessage, ZgModel } from './router.ts';

/** Generous allowance for chat-template tokens around each message. */
export const MESSAGE_OVERHEAD_TOKENS = 16;

export function promptTokenUpperBound(messages: readonly ZgMessage[]): number {
  const encoder = new TextEncoder();
  return messages.reduce(
    (sum, m) =>
      sum +
      encoder.encode(m.role).length +
      encoder.encode(m.content).length +
      MESSAGE_OVERHEAD_TOKENS,
    MESSAGE_OVERHEAD_TOKENS,
  );
}

export interface PricedModel extends ZgModel {
  readonly promptPrice: bigint;
  readonly completionPrice: bigint;
}

export function isPriced(model: ZgModel): model is PricedModel {
  return model.promptPrice !== null && model.completionPrice !== null;
}

export function worstCaseCost(model: PricedModel, promptTokens: number, maxTokens: number): bigint {
  return BigInt(promptTokens) * model.promptPrice + BigInt(maxTokens) * model.completionPrice;
}

export type CostCode =
  | 'MODEL_NOT_IN_CATALOG'
  | 'NOT_A_CHAT_MODEL'
  | 'PRICE_UNKNOWN'
  | 'COST_OVER_CAP'
  | 'BALANCE_TOO_LOW';

/** Only these catalog types answer /chat/completions as priced per token. */
export const CHAT_MODEL_TYPES: readonly string[] = ['chatbot'];

export type CostDecision =
  | {
      readonly ok: true;
      readonly model: PricedModel;
      readonly promptTokenBound: number;
      readonly worstCase: bigint;
    }
  | {
      readonly ok: false;
      readonly code: CostCode;
      readonly reason: string;
      readonly worstCase?: bigint;
    };

export interface CostCheckInput {
  readonly catalog: readonly ZgModel[];
  readonly modelId: string;
  readonly messages: readonly ZgMessage[];
  readonly maxTokens: number;
  readonly capNeuron: bigint;
  /** Spendable Router balance, when known; the worst case must fit inside it. */
  readonly availableNeuron?: bigint;
}

export function checkCallCost(input: CostCheckInput): CostDecision {
  const model = input.catalog.find((m) => m.id === input.modelId);
  if (model === undefined) {
    return {
      ok: false,
      code: 'MODEL_NOT_IN_CATALOG',
      reason: `model ${input.modelId} is not in the live catalog`,
    };
  }
  if (model.type === null || !CHAT_MODEL_TYPES.includes(model.type)) {
    return {
      ok: false,
      code: 'NOT_A_CHAT_MODEL',
      reason: `model ${input.modelId} has catalog type ${model.type ?? '(none)'}, not chatbot`,
    };
  }
  if (!isPriced(model)) {
    return {
      ok: false,
      code: 'PRICE_UNKNOWN',
      reason: `model ${input.modelId} has no usable per-token price (${model.pricingIssue ?? 'unknown'})`,
    };
  }
  const promptTokenBound = promptTokenUpperBound(input.messages);
  const worstCase = worstCaseCost(model, promptTokenBound, input.maxTokens);
  if (worstCase > input.capNeuron) {
    return {
      ok: false,
      code: 'COST_OVER_CAP',
      reason: `worst-case cost ${worstCase} neuron exceeds the per-call cap ${input.capNeuron}`,
      worstCase,
    };
  }
  if (input.availableNeuron !== undefined && worstCase > input.availableNeuron) {
    return {
      ok: false,
      code: 'BALANCE_TOO_LOW',
      reason: `worst-case cost ${worstCase} neuron exceeds the spendable balance ${input.availableNeuron}`,
      worstCase,
    };
  }
  return { ok: true, model, promptTokenBound, worstCase };
}

export interface BillingCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Post-call consistency checks on the Router's own billing figures. */
export function checkBilling(
  billing: ZgBilling,
  worstCase: bigint,
  capNeuron: bigint,
): BillingCheck[] {
  const sum = billing.inputCost + billing.outputCost;
  return [
    {
      name: 'billing is exact (no precision loss)',
      ok: billing.exact,
      detail: billing.exact ? 'all costs exact' : 'a cost exceeded 2^53 as a JSON number',
    },
    {
      name: 'total = input + output',
      ok: sum === billing.totalCost,
      detail: `${billing.inputCost} + ${billing.outputCost} = ${sum}, total ${billing.totalCost}`,
    },
    {
      name: 'total within the pre-call worst case',
      ok: billing.totalCost <= worstCase,
      detail: `${billing.totalCost} <= ${worstCase}`,
    },
    {
      name: 'total within the per-call cap',
      ok: billing.totalCost <= capNeuron,
      detail: `${billing.totalCost} <= ${capNeuron}`,
    },
  ];
}

/**
 * The Router balance from /account/balance is a working float, not the
 * spendable total: per pc.0g.ai, "the router pulls funds from the Payment
 * Layer automatically as you spend", and the API does not report the Payment
 * Layer part (D-039). So it never refuses a call; this note explains when a
 * call will need a pull. If the Payment Layer is short too, the Router answers
 * 402 insufficient_balance and nothing is charged. The per-call cap remains
 * the deterministic limit.
 */
export function routerFloatNote(worstCase: bigint, routerBalance: bigint): string | null {
  if (worstCase <= routerBalance) return null;
  return (
    `the worst case exceeds the Router float (${routerBalance} neuron); the Router pulls the ` +
    'rest from the Payment Layer as you spend (if that is short too: 402 insufficient_balance, no charge)'
  );
}
