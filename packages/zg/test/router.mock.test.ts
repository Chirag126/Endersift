// Class: mock. Faked HTTP responses shaped after the 0G Router docs. Proves
// parsing, headers and error handling only; never sponsor evidence. Live calls
// are made by `pnpm zg:models` and `pnpm zg:infer` on the owner's machine.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FetchLike } from '../src/http.ts';
import {
  ZgResponseError,
  ZgRouterClient,
  ZgRouterError,
  parseChatCompletion,
  parseModelList,
  parseTranscription,
} from '../src/router.ts';

const BASE = 'https://router.example/v1';
// Assembled at runtime: no key-shaped literal is committed.
const SK = 'sk-' + 'k'.repeat(32);
const MK = 'mk-' + 'm'.repeat(32);
const PROVIDER = '0x' + 'ab'.repeat(20);

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(
  respond: (
    url: string,
    init?: RequestInit,
  ) => { status: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = respond(url, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  };
  return { fn, calls };
}

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'test-model',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'CISA KEV lists exploited CVEs.',
        reasoning_content: 'thinking',
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  x_0g_trace: {
    request_id: 'req_abc123',
    provider: PROVIDER,
    billing: { input_cost: '2000', output_cost: '3200', total_cost: '5200' },
    tee_verified: true,
  },
};

const header = (init: RequestInit | undefined, name: string): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.[name];

describe('parsers', () => {
  it('parses the model catalog with prices rounded up', () => {
    const models = parseModelList({
      object: 'list',
      data: [
        {
          id: 'm1',
          object: 'model',
          name: 'Model 1',
          type: 'chatbot',
          context_length: 131072,
          pricing: { prompt: '1000', completion: '2500.5' },
          provider_count: 2,
        },
      ],
    });
    assert.equal(models[0]?.id, 'm1');
    assert.equal(models[0]?.type, 'chatbot');
    assert.equal(models[0]?.promptPrice, 1000n);
    assert.equal(models[0]?.completionPrice, 2501n);
    assert.throws(() => parseModelList({ data: [{ pricing: {} }] }), ZgResponseError);
    assert.throws(() => parseModelList({}), /no data array/);
  });

  it('keeps catalog capability flags (supported_parameters), dropping junk', () => {
    const [m, bare] = parseModelList({
      data: [
        {
          id: 'json-model',
          pricing: { prompt: '1', completion: '2' },
          supported_parameters: [
            'response_format',
            'chat_template_kwargs',
            42,
            'Bad Value!',
            'tools',
          ],
        },
        { id: 'bare', pricing: { prompt: '1', completion: '2' } },
      ],
    });
    assert.deepEqual(m?.supportedParameters, ['response_format', 'chat_template_kwargs', 'tools']);
    assert.deepEqual(bare?.supportedParameters, []);
  });

  it('keeps models with unusable pricing, marked unpriced, without failing the catalog', () => {
    // Shape seen live on mainnet (2026-10-25): one entry's pricing.prompt was not
    // a per-token price, which previously aborted the whole catalog.
    const models = parseModelList({
      data: [
        { id: 'chat', pricing: { prompt: '389000000000', completion: '2330000000000' } },
        { id: 'image', pricing: { image: '5000000000000000' } },
        {
          id: 'qwen-image-edit',
          pricing: { prompt: '0', completion: '0', image: '5000000000000000' },
        },
        { id: 'zero-extra', pricing: { prompt: '1', completion: '2', request: '0' } },
        { id: 'audio', pricing: { prompt: null, completion: 'per-second' } },
        { id: 'bare' },
      ],
    });
    assert.deepEqual(
      models.map((m) => [m.id, m.promptPrice, m.pricingIssue === null]),
      [
        ['chat', 389000000000n, true],
        ['image', null, false],
        ['qwen-image-edit', null, false],
        ['zero-extra', 1n, true],
        ['audio', null, false],
        ['bare', null, false],
      ],
    );
    assert.match(models[1]?.pricingIssue ?? '', /pricing\.prompt/);
    assert.equal(models[2]?.pricingIssue, 'also billed per image');
    assert.equal(models[5]?.pricingIssue, 'pricing is missing');
  });

  it('parses a completion with x_0g_trace', () => {
    const c = parseChatCompletion(COMPLETION);
    assert.equal(c.trace.requestId, 'req_abc123');
    assert.equal(c.trace.provider, PROVIDER);
    assert.equal(c.trace.billing.totalCost, 5200n);
    assert.equal(c.trace.teeVerified, true);
    assert.equal(c.usage.totalTokens, 28);
    assert.equal(c.reasoningPresent, true);
    assert.equal(c.content, 'CISA KEV lists exploited CVEs.');
  });

  it('treats tee_verified as null when absent and content null as empty', () => {
    const { tee_verified: _ignored, ...trace } = COMPLETION.x_0g_trace;
    const c = parseChatCompletion({
      ...COMPLETION,
      choices: [{ message: { role: 'assistant', content: null } }],
      x_0g_trace: trace,
    });
    assert.equal(c.trace.teeVerified, null);
    assert.equal(c.content, '');
  });

  it('rejects completions without a trustworthy trace or usage', () => {
    const { x_0g_trace: _t, ...noTrace } = COMPLETION;
    assert.throws(() => parseChatCompletion(noTrace), /x_0g_trace/);
    assert.throws(
      () =>
        parseChatCompletion({
          ...COMPLETION,
          x_0g_trace: { ...COMPLETION.x_0g_trace, provider: 'not-an-address' },
        }),
      /provider/,
    );
    assert.throws(
      () =>
        parseChatCompletion({
          ...COMPLETION,
          x_0g_trace: {
            ...COMPLETION.x_0g_trace,
            billing: { input_cost: '1', output_cost: '-1', total_cost: '0' },
          },
        }),
      /output_cost/,
    );
    const { usage: _u, ...noUsage } = COMPLETION;
    assert.throws(() => parseChatCompletion(noUsage), /usage/);
  });
});

describe('ZgRouterClient', () => {
  it('lists models without sending any credential', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 200,
      body: { data: [{ id: 'm1', pricing: { prompt: '1', completion: '2' } }] },
    }));
    const client = new ZgRouterClient({
      baseUrl: `${BASE}/`,
      apiKey: SK,
      managementKey: MK,
      fetch: fn,
    });
    const { models } = await client.listModels();
    assert.equal(models.length, 1);
    assert.equal(calls[0]?.url, `${BASE}/models`);
    assert.equal(header(calls[0]?.init, 'authorization'), undefined);
  });

  it('sends inference with the sk- key, verify_tee and max_tokens, and returns the trace', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 200,
      body: COMPLETION,
      headers: { 'ZG-Res-Key': 'chat-xyz' },
    }));
    const client = new ZgRouterClient({ baseUrl: BASE, apiKey: SK, managementKey: MK, fetch: fn });
    const result = await client.chat({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
      verifyTee: true,
    });
    const call = calls[0];
    assert.equal(call?.url, `${BASE}/chat/completions`);
    assert.equal(call?.init?.method, 'POST');
    assert.equal(call?.init?.redirect, 'error');
    assert.equal(header(call?.init, 'authorization'), `Bearer ${SK}`);
    const sent = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
    assert.equal(sent['max_tokens'], 64);
    assert.equal(sent['verify_tee'], true);
    assert.equal(sent['stream'], false);
    assert.equal(result.zgResKey, 'chat-xyz');
    assert.equal(result.completion.trace.requestId, 'req_abc123');
  });

  it('uses only the mk- key for balance reads', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 200,
      body: {
        address: PROVIDER,
        deposit_balance: '5000000000000000000',
        total_balance: '4999000000000000000',
      },
    }));
    const client = new ZgRouterClient({ baseUrl: BASE, apiKey: SK, managementKey: MK, fetch: fn });
    const balance = await client.getBalance();
    assert.equal(balance.totalBalance, 4_999_000_000_000_000_000n);
    assert.equal(calls[0]?.url, `${BASE}/account/balance`);
    assert.equal(header(calls[0]?.init, 'authorization'), `Bearer ${MK}`);
  });

  it('returns the raw balance body unchanged for diagnostics', async () => {
    const body = {
      address: PROVIDER,
      total_balance: '1',
      payment_layer_balance: '331700000000000000',
    };
    const { fn } = fakeFetch(() => ({ status: 200, body }));
    const client = new ZgRouterClient({ baseUrl: BASE, managementKey: MK, fetch: fn });
    assert.deepEqual(await client.getBalanceRaw(), body);
  });

  it('refuses account reads without a management key and inference without an API key', async () => {
    const { fn, calls } = fakeFetch(() => ({ status: 200, body: {} }));
    const client = new ZgRouterClient({ baseUrl: BASE, fetch: fn });
    await assert.rejects(client.getBalance(), /mk- management key/);
    await assert.rejects(
      client.chat({ model: 'm', messages: [], maxTokens: 1 }),
      /sk- API key is required/,
    );
    assert.equal(calls.length, 0);
  });

  it('maps documented errors (402 insufficient_balance) without retrying or leaking the key', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 402,
      body: {
        error: {
          message: 'Insufficient balance to process request.',
          type: 'payment_error',
          code: 'insufficient_balance',
        },
        request_id: 'req_402',
      },
    }));
    const client = new ZgRouterClient({ baseUrl: BASE, apiKey: SK, fetch: fn });
    const error = await client
      .chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 })
      .catch((e: unknown) => e);
    assert.ok(error instanceof ZgRouterError);
    assert.equal(error.status, 402);
    assert.equal(error.code, 'insufficient_balance');
    assert.equal(error.requestId, 'req_402');
    assert.ok(!error.message.includes(SK));
    assert.equal(calls.length, 1, 'must not retry');
  });

  it('never retries server errors and keeps Retry-After for 429', async () => {
    let n = 0;
    const { fn } = fakeFetch(() => {
      n += 1;
      return {
        status: 429,
        body: {
          error: {
            message: 'slow down\u0007\nnow',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        },
        headers: { 'Retry-After': '12' },
      };
    });
    const client = new ZgRouterClient({ baseUrl: BASE, apiKey: SK, fetch: fn });
    const error = await client
      .chat({ model: 'm', messages: [], maxTokens: 1 })
      .catch((e: unknown) => e);
    assert.ok(error instanceof ZgRouterError);
    assert.equal(error.retryAfter, '12');
    assert.ok(
      [...error.message].every((ch) => ch.charCodeAt(0) >= 0x20),
      'control characters must be stripped',
    );
    assert.equal(n, 1);
  });

  it('refuses a non-https base URL', () => {
    assert.throws(() => new ZgRouterClient({ baseUrl: 'http://router.example/v1' }), /https/);
  });
});

describe('speech to text (D-076)', () => {
  const TRACE = {
    request_id: 'stt-req-1',
    provider: PROVIDER,
    billing: { input_cost: '0', output_cost: '0', total_cost: '120000000000000' },
    tee_verified: true,
  };

  it('parses the documented { text } and a trace when the Router sends one', () => {
    assert.deepEqual(parseTranscription({ text: 'openssl and lodash' }), {
      text: 'openssl and lodash',
      model: null,
      trace: null,
    });
    const t = parseTranscription({
      text: 'nginx',
      model: 'whisper-large-v3',
      x_0g_trace: TRACE,
    });
    assert.equal(t.trace?.requestId, 'stt-req-1');
    assert.equal(t.trace?.billing.totalCost, 120000000000000n);
    assert.equal(t.trace?.teeVerified, true);
    assert.throws(() => parseTranscription({}), ZgResponseError);
    assert.throws(() => parseTranscription({ text: 5 }), ZgResponseError);
    assert.throws(() => parseTranscription({ text: 'x'.repeat(4001) }), /longer than/);
    // a trace that is present but broken is not quietly dropped
    assert.throws(
      () => parseTranscription({ text: 'a', x_0g_trace: { request_id: '' } }),
      ZgResponseError,
    );
  });

  it('posts multipart audio with the sk- key and verify_tee in the query, once', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 200,
      body: { text: 'openssl', x_0g_trace: TRACE },
      headers: { 'zg-res-key': 'chat-9' },
    }));
    const client = new ZgRouterClient({ baseUrl: BASE, apiKey: SK, managementKey: MK, fetch: fn });
    const r = await client.transcribe({
      model: 'whisper-large-v3',
      audio: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/webm',
      filename: 'voice.webm',
      language: 'en',
      verifyTee: true,
    });
    assert.equal(r.transcription.text, 'openssl');
    assert.equal(r.zgResKey, 'chat-9');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `${BASE}/audio/transcriptions?verify_tee=true`);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    assert.equal(headers['authorization'], `Bearer ${SK}`);
    assert.equal(headers['content-type'], undefined); // fetch sets the multipart boundary
    const form = calls[0]?.init?.body as FormData;
    assert.equal(form.get('model'), 'whisper-large-v3');
    assert.equal(form.get('language'), 'en');
    assert.equal(form.get('response_format'), 'json');
    const file = form.get('file') as File;
    assert.equal(file.name, 'voice.webm');
    assert.equal(file.type, 'audio/webm');
    assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3]);
  });

  it('maps Router errors, needs an API key, and never retries', async () => {
    const { fn, calls } = fakeFetch(() => ({
      status: 502,
      body: {
        error: { type: 'server_error', code: 'provider_error', message: 'down' },
        request_id: 'r-502',
      },
    }));
    const client = new ZgRouterClient({ baseUrl: BASE, apiKey: SK, fetch: fn });
    const request = {
      model: 'whisper-large-v3',
      audio: new Uint8Array([1]),
      mimeType: 'audio/webm',
      filename: 'voice.webm',
    };
    await assert.rejects(client.transcribe(request), (e: unknown) => {
      assert.ok(e instanceof ZgRouterError);
      assert.equal(e.status, 502);
      assert.equal(e.requestId, 'r-502');
      assert.ok(!e.message.includes(SK));
      return true;
    });
    assert.equal(calls.length, 1);
    await assert.rejects(
      new ZgRouterClient({ baseUrl: BASE, fetch: fn }).transcribe(request),
      /sk- API key/,
    );
  });
});
