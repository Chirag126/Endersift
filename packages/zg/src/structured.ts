/**
 * Structured (JSON-schema) outputs from the 0G Router (plan row 17).
 *
 *   plan  (pure)  model from the live catalog must be a priced chatbot that lists
 *                 `response_format` (JSON mode); worst-case cost must fit the cap
 *                 and the balance. Thinking is switched off when the model lists
 *                 `chat_template_kwargs`, so the output budget is spent on the
 *                 answer (the Phase 4 run showed reasoning can consume all of it).
 *  call  (once)  one chat completion with response_format json_object, a timeout
 *                and verify_tee. NEVER retried: every call is paid, so a bad
 *                output is reported with its cost, not replayed blindly.
 *  read  (pure)  the content must be one JSON object (a single ```json fence is
 *                tolerated) that satisfies the zod schema. Failures are typed:
 *                EMPTY_OUTPUT, TRUNCATED, NOT_JSON, SCHEMA_INVALID.
 *
 * The schema is a zod schema; its JSON Schema (z.toJSONSchema) is embedded in
 * the system prompt, since the Router documents JSON mode ({"type":
 * "json_object"}) but not server-side json_schema enforcement. Validation
 * therefore always happens here.
 */
import { z } from 'zod';
import { checkCallCost, type CostCode } from './cost.ts';
import type { ZgRouterClient, ZgChatCompletion, ZgMessage, ZgModel } from './router.ts';

export interface StructuredTask<T> {
  /** Short identifier for logs and the ledger, e.g. "triage". */
  readonly name: string;
  /** What the model must do (no output-format instructions; those are added). */
  readonly instructions: string;
  /** The input, already delimited by the caller if it contains untrusted data. */
  readonly input: string;
  readonly schema: z.ZodType<T>;
}

export type StructuredRefusalCode = CostCode | 'NOT_JSON_CAPABLE';

export type StructuredPlan =
  | {
      readonly ok: true;
      readonly model: ZgModel;
      readonly messages: readonly ZgMessage[];
      readonly maxTokens: number;
      readonly worstCase: bigint;
      readonly thinkingDisabled: boolean;
    }
  | { readonly ok: false; readonly code: StructuredRefusalCode; readonly reason: string };

/** The JSON Schema the model is asked to follow (draft 2020-12 from zod). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

export function structuredMessages(task: StructuredTask<unknown>): ZgMessage[] {
  return [
    {
      role: 'system',
      content: [
        task.instructions,
        '',
        'Output format: reply with exactly one JSON object and nothing else (no prose, no code fence).',
        'It must validate against this JSON Schema:',
        JSON.stringify(jsonSchemaOf(task.schema)),
      ].join('\n'),
    },
    { role: 'user', content: task.input },
  ];
}

export function planStructuredCall(input: {
  readonly catalog: readonly ZgModel[];
  readonly modelId: string;
  readonly task: StructuredTask<unknown>;
  readonly maxTokens: number;
  readonly capNeuron: bigint;
  readonly availableNeuron?: bigint;
}): StructuredPlan {
  const messages = structuredMessages(input.task);
  const cost = checkCallCost({
    catalog: input.catalog,
    modelId: input.modelId,
    messages,
    maxTokens: input.maxTokens,
    capNeuron: input.capNeuron,
    ...(input.availableNeuron === undefined ? {} : { availableNeuron: input.availableNeuron }),
  });
  if (!cost.ok) return { ok: false, code: cost.code, reason: cost.reason };
  if (!cost.model.supportedParameters.includes('response_format')) {
    return {
      ok: false,
      code: 'NOT_JSON_CAPABLE',
      reason: `model ${input.modelId} does not list response_format in the catalog`,
    };
  }
  return {
    ok: true,
    model: cost.model,
    messages,
    maxTokens: input.maxTokens,
    worstCase: cost.worstCase,
    thinkingDisabled: cost.model.supportedParameters.includes('chat_template_kwargs'),
  };
}

export type StructuredFailureCode = 'EMPTY_OUTPUT' | 'TRUNCATED' | 'NOT_JSON' | 'SCHEMA_INVALID';

export type StructuredReading<T> =
  | { readonly ok: true; readonly value: T; readonly unfenced: boolean }
  | {
      readonly ok: false;
      readonly code: StructuredFailureCode;
      readonly reason: string;
      /** Up to 10 schema issues as "path: message" (never the offending values). */
      readonly issues: readonly string[];
    };

/** Strip one surrounding ```json … ``` fence, if that is all there is around the object. */
function unfence(content: string): { text: string; unfenced: boolean } {
  const trimmed = content.trim();
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return m?.[1] === undefined
    ? { text: trimmed, unfenced: false }
    : { text: m[1].trim(), unfenced: true };
}

export function readStructured<T>(
  completion: Pick<ZgChatCompletion, 'content' | 'finishReason'>,
  schema: z.ZodType<T>,
): StructuredReading<T> {
  const fail = (code: StructuredFailureCode, reason: string, issues: string[] = []) =>
    ({ ok: false, code, reason, issues }) as const;
  const { text, unfenced } = unfence(completion.content);
  if (text === '') {
    return fail(
      'EMPTY_OUTPUT',
      `no content (finish_reason ${completion.finishReason ?? 'unknown'})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return completion.finishReason === 'length'
      ? fail('TRUNCATED', 'the output hit max_tokens before the JSON was complete')
      : fail('NOT_JSON', 'the content is not a single JSON value');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('NOT_JSON', 'the content is JSON but not an object');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return fail(
      'SCHEMA_INVALID',
      'the JSON does not satisfy the schema',
      result.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return { ok: true, value: result.data, unfenced };
}

export interface StructuredCallResult<T> {
  readonly completion: ZgChatCompletion;
  readonly zgResKey: string | null;
  readonly raw: unknown;
  /** The reading of the (paid) output: a typed value or a typed failure. */
  readonly reading: StructuredReading<T>;
}

/**
 * One paid call for a successful plan. Router and transport errors throw
 * (ZgRouterError, ZgTransportError); an unusable output does not: it comes
 * back as `reading.ok === false`, together with the billed completion.
 */
export async function callStructured<T>(
  client: ZgRouterClient,
  plan: Extract<StructuredPlan, { ok: true }>,
  schema: z.ZodType<T>,
  options: { readonly timeoutMs: number; readonly verifyTee?: boolean } = { timeoutMs: 60_000 },
): Promise<StructuredCallResult<T>> {
  const result = await client.chat({
    model: plan.model.id,
    messages: plan.messages,
    maxTokens: plan.maxTokens,
    temperature: 0,
    responseFormat: 'json_object',
    ...(plan.thinkingDisabled ? { chatTemplateKwargs: { enable_thinking: false } } : {}),
    verifyTee: options.verifyTee ?? true,
    timeoutMs: options.timeoutMs,
  });
  return {
    completion: result.completion,
    zgResKey: result.zgResKey,
    raw: result.raw,
    reading: readStructured(result.completion, schema),
  };
}
