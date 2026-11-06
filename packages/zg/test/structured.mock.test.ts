// Class: mock. Faked Router responses; proves planning, the request sent and
// output reading. Never sponsor evidence: the live call is `pnpm zg:structured`.
// Needs zod (CI and owner's machine).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { FetchLike } from '../src/http.ts';
import { ZgRouterClient, type ZgModel } from '../src/router.ts';
import {
  callStructured,
  jsonSchemaOf,
  planStructuredCall,
  readStructured,
  structuredMessages,
  type StructuredTask,
} from '../src/structured.ts';

const SK = 'sk-' + 'k'.repeat(32);
const PROVIDER = '0x' + 'ab'.repeat(20);
const Schema = z
  .object({ id: z.string().regex(/^CVE-\d{4}-\d{4,7}$/), priority: z.enum(['p1', 'p2', 'p3']) })
  .strict();
const TASK: StructuredTask<z.infer<typeof Schema>> = {
  name: 'test',
  instructions: 'Rate the advisory.',
  input: '<advisories>id: CVE-2021-44228</advisories>',
  schema: Schema,
};
const MODEL: ZgModel = {
  id: 'json-model',
  name: 'JSON',
  type: 'chatbot',
  contextLength: 8192,
  promptPrice: 100n,
  completionPrice: 400n,
  providerCount: 1,
  pricingIssue: null,
  supportedParameters: ['max_tokens', 'response_format', 'chat_template_kwargs'],
};

const completion = (content: string, finish = 'stop') => ({
  id: 'chatcmpl-1',
  model: 'json-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
  usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  x_0g_trace: {
    request_id: 'req_1',
    provider: PROVIDER,
    billing: { input_cost: '5000', output_cost: '8000', total_cost: '13000' },
    tee_verified: true,
  },
});

function client(content: string, finish = 'stop') {
  const bodies: Record<string, unknown>[] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    signals.push(init?.signal);
    return new Response(JSON.stringify(completion(content, finish)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    c: new ZgRouterClient({ baseUrl: 'https://router.example/v1', apiKey: SK, fetch }),
    bodies,
    signals,
  };
}

const plan = (model = MODEL, cap = 10n ** 12n) =>
  planStructuredCall({
    catalog: [model],
    modelId: model.id,
    task: TASK,
    maxTokens: 256,
    capNeuron: cap,
  });

describe('planStructuredCall', () => {
  it('requires a JSON-capable model and turns thinking off when supported', () => {
    const ok = plan();
    assert.ok(ok.ok);
    if (ok.ok) assert.equal(ok.thinkingDisabled, true);
    const noKwargs = plan({ ...MODEL, supportedParameters: ['response_format'] });
    assert.ok(noKwargs.ok && !noKwargs.thinkingDisabled);
    const noJson = plan({ ...MODEL, supportedParameters: ['max_tokens'] });
    assert.deepEqual(noJson.ok ? null : noJson.code, 'NOT_JSON_CAPABLE');
  });

  it('applies the deterministic cost cap before any call', () => {
    const refused = plan(MODEL, 1n);
    assert.equal(refused.ok ? null : refused.code, 'COST_OVER_CAP');
    const missing = planStructuredCall({
      catalog: [],
      modelId: 'x',
      task: TASK,
      maxTokens: 1,
      capNeuron: 1n,
    });
    assert.equal(missing.ok ? null : missing.code, 'MODEL_NOT_IN_CATALOG');
  });

  it('embeds the JSON Schema of the zod schema in the system prompt', () => {
    const [system, user] = structuredMessages(TASK);
    const schema = jsonSchemaOf(Schema);
    assert.equal(schema['type'], 'object');
    assert.ok(system?.content.includes(JSON.stringify(schema)));
    assert.match(system?.content ?? '', /exactly one JSON object/);
    assert.equal(user?.content, TASK.input);
  });
});

describe('readStructured', () => {
  const read = (content: string, finish: string | null = 'stop') =>
    readStructured({ content, finishReason: finish }, Schema);

  it('accepts schema-valid JSON, tolerating one code fence', () => {
    assert.deepEqual(read('{"id":"CVE-2021-44228","priority":"p1"}'), {
      ok: true,
      value: { id: 'CVE-2021-44228', priority: 'p1' },
      unfenced: false,
    });
    const fenced = read('```json\n{"id":"CVE-2021-44228","priority":"p2"}\n```');
    assert.ok(fenced.ok && fenced.unfenced);
  });

  it('types every failure without echoing values', () => {
    const code = (r: ReturnType<typeof read>) => (r.ok ? 'ok' : r.code);
    assert.equal(code(read('')), 'EMPTY_OUTPUT');
    assert.equal(code(read('{"id": "CVE-2021', 'length')), 'TRUNCATED');
    assert.equal(code(read('Sure! Here is the JSON: {...}')), 'NOT_JSON');
    assert.equal(code(read('[1,2]')), 'NOT_JSON');
    const bad = read('{"id":"not-a-cve","priority":"urgent","extra":1}');
    assert.equal(code(bad), 'SCHEMA_INVALID');
    if (!bad.ok) {
      assert.ok(bad.issues.length >= 2);
      assert.ok(!bad.issues.join(' ').includes('urgent'), 'issues name paths, not values');
    }
  });
});

describe('callStructured', () => {
  it('sends JSON mode, thinking off, temperature 0, verify_tee and the timeout, once', async () => {
    const { c, bodies, signals } = client('{"id":"CVE-2021-44228","priority":"p1"}');
    const p = plan();
    assert.ok(p.ok);
    if (!p.ok) return;
    const r = await callStructured(c, p, Schema, { timeoutMs: 5_000 });
    assert.ok(r.reading.ok);
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0]?.['response_format'], { type: 'json_object' });
    assert.deepEqual(bodies[0]?.['chat_template_kwargs'], { enable_thinking: false });
    assert.equal(bodies[0]?.['temperature'], 0);
    assert.equal(bodies[0]?.['verify_tee'], true);
    assert.equal(bodies[0]?.['max_tokens'], 256);
    assert.ok(signals[0] instanceof AbortSignal, 'a timeout signal is attached');
  });

  it('never retries: an invalid output comes back typed, with its billing', async () => {
    const { c, bodies } = client('not json at all');
    const p = plan();
    assert.ok(p.ok);
    if (!p.ok) return;
    const r = await callStructured(c, p, Schema, { timeoutMs: 5_000 });
    assert.equal(r.reading.ok ? 'ok' : r.reading.code, 'NOT_JSON');
    assert.equal(r.completion.trace.billing.totalCost, 13_000n, 'the paid cost is still reported');
    assert.equal(bodies.length, 1, 'exactly one request');
  });

  it('omits chat_template_kwargs for models that do not list it', async () => {
    const { c, bodies } = client('{"id":"CVE-2021-44228","priority":"p3"}');
    const p = plan({ ...MODEL, supportedParameters: ['response_format'] });
    assert.ok(p.ok);
    if (!p.ok) return;
    await callStructured(c, p, Schema, { timeoutMs: 5_000 });
    assert.equal('chat_template_kwargs' in (bodies[0] ?? {}), false);
  });
});
