/**
 * The orchestrator's `infer` in production: every call goes through the
 * inference ledger (`ledgeredStructuredCall`, D-040): per-call cap, daily-cap
 * reservation, ONE call, never retried. The model catalog is read once per
 * process and reused (prices change rarely; a stale price can only make the
 * worst case wrong in the cap's favour if the Router lowers it, and the
 * ledger records the Router's actual bill either way).
 */
import type { InferenceCall } from '@agent-economy/core/domain';
import type { ZgModel, ZgRouterClient } from '@agent-economy/zg';
import {
  ledgeredStructuredCall,
  routerErrorCode,
  type LedgeredCallDeps,
  type LedgeredCallResult,
} from '../inference/ledgered-call.ts';
import type { Infer, InferOutcome } from './orchestrator.ts';

export interface LedgeredInferenceConfig {
  readonly network: InferenceCall['network'];
  readonly modelId: string;
  readonly capNeuron: bigint;
  readonly dailyCapNeuron: bigint;
  readonly timeoutMs: number;
}

/** Map one ledgered result onto the orchestrator's outcome. Pure. */
export function toInferOutcome<T>(r: LedgeredCallResult<T>): InferOutcome<T> {
  switch (r.kind) {
    case 'refused':
      return { ok: false, call: r.call, code: r.code, reason: r.reason };
    case 'router-error':
      return { ok: false, call: r.call, code: routerErrorCode(r.error), reason: r.error.message };
    case 'unknown':
      return { ok: false, call: r.call, code: 'OUTCOME_UNKNOWN', reason: r.error };
    case 'completed':
      if (r.call.status !== 'SUCCEEDED')
        return {
          ok: false,
          call: r.call,
          code: r.call.errorCode ?? 'CALL_FAILED',
          reason: r.reading.ok ? 'the output was not usable' : r.reading.reason,
          issues: r.reading.ok ? [] : r.reading.issues,
        };
      return r.reading.ok
        ? { ok: true, call: r.call, value: r.reading.value }
        : {
            ok: false,
            call: r.call,
            code: `OUTPUT_${r.reading.code}`,
            reason: r.reading.reason,
            issues: r.reading.issues,
          };
  }
}

/** How often a catalog without the model is read again (D-079). */
export const CATALOG_RECHECK_MS = 60_000;

export function ledgeredInference(
  deps: LedgeredCallDeps & { readonly client: ZgRouterClient },
  config: LedgeredInferenceConfig,
  call: typeof ledgeredStructuredCall = ledgeredStructuredCall,
): Infer {
  // read on first use and kept while it lists the model; while the model is missing it is read
  // again at most once a minute, so 0G listing the model again needs no restart (D-079).
  // A failed read throws and is not cached.
  let catalog: readonly ZgModel[] | null = null;
  let readAt = 0;
  const models = async (): Promise<readonly ZgModel[]> => {
    const t = Date.now();
    const stale =
      catalog !== null &&
      !catalog.some((m) => m.id === config.modelId) &&
      t - readAt >= CATALOG_RECHECK_MS;
    if (catalog === null || stale) {
      catalog = (await deps.client.listModels()).models;
      readAt = t;
    }
    return catalog;
  };
  return async (request) =>
    toInferOutcome(
      await call(deps, {
        runId: request.runId,
        purpose: request.purpose,
        network: config.network,
        modelId: config.modelId,
        catalog: await models(),
        task: request.task,
        maxTokens: request.maxTokens,
        capNeuron: config.capNeuron,
        dailyCapNeuron: config.dailyCapNeuron,
        timeoutMs: config.timeoutMs,
      }),
    );
}

/**
 * The largest prompt (in the ledger's token upper bound) that keeps a call of
 * `maxTokens` within `capNeuron` at the model's catalog prices, minus a 10 %
 * margin; null if the model is unpriced or nothing would fit. Pure.
 */
export function promptBudget(model: ZgModel, capNeuron: bigint, maxTokens: number): number | null {
  if (model.promptPrice === null || model.completionPrice === null || model.promptPrice <= 0n)
    return null;
  const left = capNeuron - BigInt(maxTokens) * model.completionPrice;
  if (left <= 0n) return null;
  const tokens = Number(left / model.promptPrice);
  const budget = Math.floor(tokens * 0.9);
  return budget > 0 ? budget : null;
}
