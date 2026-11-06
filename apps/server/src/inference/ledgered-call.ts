/**
 * The only way the agent spends 0G (plan row 18): every structured call goes
 * through the ledger, in this order, and is never retried.
 *
 *   1. plan    per-call cap, catalog price, JSON capability  → REFUSED row on failure
 *   2. reserve daily cap, worst case reserved as PENDING      → REFUSED row on failure
 *   3. call    one chat completion (callStructured)
 *   4. settle  SUCCEEDED   billed, schema-valid output, TEE signature not invalid
 *              FAILED      billed but unusable output (cost counts), or a
 *                          Router error response (not billed)
 *              UNKNOWN     transport error or timeout (worst case stays counted)
 *
 * Every decision before sending depends only on configuration, the catalog
 * and the ledger, never on model output. If the process dies after step 2,
 * the PENDING row keeps the worst case counted: the cap can only err high.
 */
import { randomUUID } from 'node:crypto';
import type { InferenceCall } from '@agent-economy/core/domain';
import {
  ZgRouterError,
  callStructured,
  planStructuredCall,
  type StructuredReading,
  type StructuredTask,
  type ZgChatCompletion,
  type ZgModel,
  type ZgRouterClient,
} from '@agent-economy/zg';
import type { InferenceLedger } from '../ledger/inference-ledger.ts';

export interface LedgeredCallInput<T> {
  readonly runId: string | null;
  readonly purpose: InferenceCall['purpose'];
  readonly network: InferenceCall['network'];
  readonly modelId: string;
  readonly catalog: readonly ZgModel[];
  readonly task: StructuredTask<T>;
  readonly maxTokens: number;
  readonly capNeuron: bigint;
  readonly dailyCapNeuron: bigint;
  readonly timeoutMs: number;
}

export interface LedgeredCallDeps {
  readonly client: ZgRouterClient;
  readonly ledger: InferenceLedger;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export type LedgeredCallResult<T> =
  | {
      readonly kind: 'refused';
      readonly code: string;
      readonly reason: string;
      readonly call: InferenceCall;
    }
  | {
      readonly kind: 'completed';
      readonly call: InferenceCall;
      readonly completion: ZgChatCompletion;
      readonly reading: StructuredReading<T>;
      readonly worstCase: bigint;
      readonly spentBefore: bigint;
    }
  | {
      readonly kind: 'router-error';
      readonly call: InferenceCall;
      readonly error: ZgRouterError;
    }
  | { readonly kind: 'unknown'; readonly call: InferenceCall; readonly error: string };

/** Ledger error code for a Router error: status plus the Router's own code, sanitised. */
export function routerErrorCode(error: ZgRouterError): string {
  const code = (error.code ?? error.type ?? 'error').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
  return `ROUTER_${error.status}_${code}`;
}

export async function ledgeredStructuredCall<T>(
  deps: LedgeredCallDeps,
  input: LedgeredCallInput<T>,
): Promise<LedgeredCallResult<T>> {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const id = (deps.newId ?? randomUUID)();
  const common = {
    id,
    runId: input.runId,
    purpose: input.purpose,
    network: input.network,
    model: input.modelId,
  };

  const plan = planStructuredCall({
    catalog: input.catalog,
    modelId: input.modelId,
    task: input.task,
    maxTokens: input.maxTokens,
    capNeuron: input.capNeuron,
  });
  if (!plan.ok) {
    const call = await deps.ledger.recordRefusal({
      ...common,
      errorCode: plan.code,
      worstCaseNeuron: null,
      at: now(),
    });
    return { kind: 'refused', code: plan.code, reason: plan.reason, call };
  }

  const reservation = await deps.ledger.reserve({
    ...common,
    worstCaseNeuron: plan.worstCase,
    dailyCapNeuron: input.dailyCapNeuron,
    at: now(),
  });
  if (!reservation.ok) {
    return {
      kind: 'refused',
      code: reservation.code,
      reason: reservation.reason,
      call: reservation.call,
    };
  }

  let result: Awaited<ReturnType<typeof callStructured<T>>>;
  try {
    result = await callStructured(deps.client, plan, input.task.schema, {
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    if (error instanceof ZgRouterError) {
      const call = await deps.ledger.settle(
        id,
        { status: 'FAILED', errorCode: routerErrorCode(error), requestId: error.requestId },
        now(),
      );
      return { kind: 'router-error', call, error };
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const call = await deps.ledger.settle(
      id,
      { status: 'UNKNOWN', errorCode: error instanceof Error ? error.name.slice(0, 100) : 'ERROR' },
      now(),
    );
    return { kind: 'unknown', call, error: message };
  }

  const c = result.completion;
  const billing = {
    requestId: c.trace.requestId,
    provider: c.trace.provider,
    promptTokens: c.usage.promptTokens,
    completionTokens: c.usage.completionTokens,
    costNeuron: c.trace.billing.totalCost,
    teeVerified: c.trace.teeVerified,
  };
  // A present-but-invalid TEE signature makes the output unusable, though it was billed.
  const failure =
    c.trace.teeVerified === false
      ? 'TEE_SIGNATURE_INVALID'
      : result.reading.ok
        ? null
        : `OUTPUT_${result.reading.code}`;
  const call = await deps.ledger.settle(
    id,
    failure === null
      ? { status: 'SUCCEEDED', ...billing }
      : { status: 'FAILED', errorCode: failure, ...billing },
    now(),
  );
  return {
    kind: 'completed',
    call,
    completion: c,
    reading: result.reading,
    worstCase: plan.worstCase,
    spentBefore: reservation.spentBefore,
  };
}
