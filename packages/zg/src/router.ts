/**
 * 0G Private Computer Router client (OpenAI-compatible, plain fetch).
 *
 * Sources (docs.0g.ai, Router section, read 2026-10-26):
 *  - Inference: POST {base}/chat/completions, `Authorization: Bearer sk-...`.
 *    Every response carries `x_0g_trace` { request_id, provider, billing
 *    { input_cost, output_cost, total_cost } in neuron, tee_verified? }.
 *    `verify_tee: true` asks the Router to check the provider's TEE signature.
 *    The `ZG-Res-Key` response header is the chat ID for independent checks.
 *  - Catalog: GET {base}/models, no auth; pricing.prompt/completion in neuron per token.
 *  - Balance: GET {base}/account/balance with an mk- key (scope account:read);
 *    sk- keys get 403. Fields address, deposit_balance, total_balance (neuron).
 *  - Speech to text: POST {base}/audio/transcriptions, multipart (file, model,
 *    language, response_format), OpenAI-compatible; Router extensions go in the
 *    query string (`?verify_tee=true`). Documented response: { text } (Router
 *    docs, Audio Transcription, read 2026-10-31). Whether `x_0g_trace` comes
 *    back is not documented, so it is parsed when present and never invented.
 *  - Errors: { error: { message, type, code }, request_id? }; 402
 *    insufficient_balance, 429 with Retry-After, 502/503 provider problems.
 *
 * This client NEVER retries. A replayed inference call spends credits twice,
 * so retry decisions belong to the caller, with a ledger (Phase 15/16).
 * Keys are held privately and never appear in errors or return values.
 */
import { isRecord, sanitizeText, sendJson, type FetchLike, type RawResponse } from './http.ts';
import { parseNeuron, parsePriceCeil } from './units.ts';

// ── types ─────────────────────────────────────────────────────────────────

export interface ZgModel {
  readonly id: string;
  readonly name: string | null;
  /** Catalog `type`, e.g. chatbot, embedding, speech-to-text, text-to-image. */
  readonly type: string | null;
  readonly contextLength: number | null;
  /** Neuron per input token, rounded up; null when the catalog gives no usable per-token price. */
  readonly promptPrice: bigint | null;
  /** Neuron per output token, rounded up; null when the catalog gives no usable per-token price. */
  readonly completionPrice: bigint | null;
  readonly providerCount: number | null;
  /** Why the per-token price is unusable (e.g. a model priced per image/request), else null. */
  readonly pricingIssue: string | null;
  /** Catalog `supported_parameters` (capability flags), e.g. response_format, chat_template_kwargs. */
  readonly supportedParameters: readonly string[];
}

export interface ZgMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ZgUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface ZgBilling {
  readonly inputCost: bigint;
  readonly outputCost: bigint;
  readonly totalCost: bigint;
  /** False if a cost arrived as a JSON number beyond 2^53 (precision lost in transit). */
  readonly exact: boolean;
}

export interface ZgTrace {
  readonly requestId: string;
  /** On-chain address of the provider that served the request. */
  readonly provider: string;
  readonly billing: ZgBilling;
  /** true = TEE signature verified by the Router; false = present but invalid; null = not requested. */
  readonly teeVerified: boolean | null;
}

export interface ZgChatCompletion {
  readonly id: string | null;
  readonly model: string;
  readonly content: string;
  readonly reasoningPresent: boolean;
  readonly finishReason: string | null;
  readonly usage: ZgUsage;
  readonly trace: ZgTrace;
}

export interface ZgTranscription {
  /** The words heard. Untrusted model output: callers validate before use. */
  readonly text: string;
  readonly model: string | null;
  /** Request ID and billing, when the Router sends them; null when it does not. */
  readonly trace: ZgTrace | null;
}

export interface ZgBalance {
  readonly address: string;
  readonly depositBalance: bigint;
  /** What is available to spend right now (may lag the on-chain Payment Layer). */
  readonly totalBalance: bigint;
}

export class ZgResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZgResponseError';
  }
}

/** A non-2xx answer from the Router, parsed from its documented error shape. */
export class ZgRouterError extends Error {
  readonly status: number;
  readonly type: string | null;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly retryAfter: string | null;
  constructor(init: {
    status: number;
    type: string | null;
    code: string | null;
    message: string;
    requestId: string | null;
    retryAfter: string | null;
  }) {
    const what = [init.type, init.code].filter((x) => x !== null).join('/');
    const id = init.requestId === null ? '' : ` (request_id ${init.requestId})`;
    super(`0G Router HTTP ${init.status}${what === '' ? '' : ` ${what}`}: ${init.message}${id}`);
    this.name = 'ZgRouterError';
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
  }
}

// ── parsers (all Router output is untrusted input) ────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function optString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nonNegInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ZgResponseError(`${field} is not a non-negative integer`);
  }
  return value;
}

export function parseModelList(body: unknown): ZgModel[] {
  if (!isRecord(body) || !Array.isArray(body['data'])) {
    throw new ZgResponseError('models response has no data array');
  }
  return body['data'].map((entry: unknown, i): ZgModel => {
    if (!isRecord(entry) || typeof entry['id'] !== 'string' || entry['id'] === '') {
      throw new ZgResponseError(`data[${i}] has no id`);
    }
    // One model with unusual pricing (per image, per request, missing) must not
    // hide the rest of the catalog. It is kept, marked unpriced, and the cost
    // check refuses it (PRICE_UNKNOWN) instead of guessing.
    const pricing = entry['pricing'];
    let promptPrice: bigint | null = null;
    let completionPrice: bigint | null = null;
    let pricingIssue: string | null = null;
    if (!isRecord(pricing)) {
      pricingIssue = 'pricing is missing';
    } else {
      try {
        promptPrice = parsePriceCeil(pricing['prompt'], 'pricing.prompt');
        completionPrice = parsePriceCeil(pricing['completion'], 'pricing.completion');
        // A model can bill along other dimensions too (seen live: an image model
        // with prompt=0, completion=0, image=5e15). Per-token prices alone would
        // then understate the cost, so treat it as unpriced.
        const other = Object.entries(pricing).find(
          ([key, value]) =>
            key !== 'prompt' &&
            key !== 'completion' &&
            value !== '0' &&
            value !== 0 &&
            value !== null,
        );
        if (other !== undefined) throw new Error(`also billed per ${other[0]}`);
      } catch (error) {
        promptPrice = null;
        completionPrice = null;
        pricingIssue = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      id: entry['id'],
      name: optString(entry['name']),
      type: optString(entry['type']),
      contextLength: typeof entry['context_length'] === 'number' ? entry['context_length'] : null,
      promptPrice,
      completionPrice,
      providerCount: typeof entry['provider_count'] === 'number' ? entry['provider_count'] : null,
      pricingIssue,
      supportedParameters: Array.isArray(entry['supported_parameters'])
        ? entry['supported_parameters']
            .filter((p): p is string => typeof p === 'string' && /^[a-z0-9_]{1,64}$/.test(p))
            .slice(0, 100)
        : [],
    };
  });
}

function parseTrace(value: unknown): ZgTrace {
  if (!isRecord(value)) throw new ZgResponseError('response has no x_0g_trace');
  const requestId = value['request_id'];
  if (typeof requestId !== 'string' || requestId === '') {
    throw new ZgResponseError('x_0g_trace.request_id is missing');
  }
  const provider = value['provider'];
  if (typeof provider !== 'string' || !ADDRESS.test(provider)) {
    throw new ZgResponseError('x_0g_trace.provider is not an address');
  }
  const billing = value['billing'];
  if (!isRecord(billing)) throw new ZgResponseError('x_0g_trace.billing is missing');
  let input: ReturnType<typeof parseNeuron>;
  let output: ReturnType<typeof parseNeuron>;
  let total: ReturnType<typeof parseNeuron>;
  try {
    input = parseNeuron(billing['input_cost'], 'billing.input_cost');
    output = parseNeuron(billing['output_cost'], 'billing.output_cost');
    total = parseNeuron(billing['total_cost'], 'billing.total_cost');
  } catch (error) {
    throw new ZgResponseError(error instanceof Error ? error.message : String(error));
  }
  const tee = value['tee_verified'];
  return {
    requestId,
    provider,
    billing: {
      inputCost: input.neuron,
      outputCost: output.neuron,
      totalCost: total.neuron,
      exact: input.exact && output.exact && total.exact,
    },
    teeVerified: typeof tee === 'boolean' ? tee : null,
  };
}

export function parseChatCompletion(body: unknown): ZgChatCompletion {
  if (!isRecord(body)) throw new ZgResponseError('completion is not an object');
  const choices = body['choices'];
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  if (!isRecord(first) || !isRecord(first['message'])) {
    throw new ZgResponseError('completion has no choices[0].message');
  }
  const message = first['message'];
  const content = message['content'];
  if (content !== null && content !== undefined && typeof content !== 'string') {
    throw new ZgResponseError('choices[0].message.content is not text');
  }
  const reasoning = message['reasoning_content'];
  const usage = body['usage'];
  if (!isRecord(usage)) throw new ZgResponseError('completion has no usage');
  const model = body['model'];
  if (typeof model !== 'string') throw new ZgResponseError('completion has no model');

  return {
    id: optString(body['id']),
    model,
    content: typeof content === 'string' ? content : '',
    reasoningPresent: typeof reasoning === 'string' && reasoning.length > 0,
    finishReason: optString(first['finish_reason']),
    usage: {
      promptTokens: nonNegInt(usage['prompt_tokens'], 'usage.prompt_tokens'),
      completionTokens: nonNegInt(usage['completion_tokens'], 'usage.completion_tokens'),
      totalTokens: nonNegInt(usage['total_tokens'], 'usage.total_tokens'),
    },
    trace: parseTrace(body['x_0g_trace']),
  };
}

/** Longest transcript accepted (a 30 s clip is a few hundred characters). */
export const MAX_TRANSCRIPT_CHARS = 4000;

export function parseTranscription(body: unknown): ZgTranscription {
  if (!isRecord(body)) throw new ZgResponseError('transcription is not an object');
  const text = body['text'];
  if (typeof text !== 'string') throw new ZgResponseError('transcription has no text');
  if (text.length > MAX_TRANSCRIPT_CHARS)
    throw new ZgResponseError(`transcription is longer than ${MAX_TRANSCRIPT_CHARS} characters`);
  const trace = body['x_0g_trace'];
  return {
    text,
    model: optString(body['model']),
    // a trace that is present must be well-formed; an absent one stays absent
    trace: trace === undefined || trace === null ? null : parseTrace(trace),
  };
}

export function parseBalance(body: unknown): ZgBalance {
  if (!isRecord(body)) throw new ZgResponseError('balance response is not an object');
  const address = body['address'];
  if (typeof address !== 'string' || !ADDRESS.test(address)) {
    throw new ZgResponseError('balance.address is not an address');
  }
  try {
    return {
      address,
      depositBalance: parseNeuron(body['deposit_balance'], 'deposit_balance').neuron,
      totalBalance: parseNeuron(body['total_balance'], 'total_balance').neuron,
    };
  } catch (error) {
    throw new ZgResponseError(error instanceof Error ? error.message : String(error));
  }
}

/** Turn a non-2xx response into a ZgRouterError (documented shape, tolerant of others). */
export function routerErrorFrom(response: RawResponse): ZgRouterError {
  const body = response.body;
  const err = isRecord(body) && isRecord(body['error']) ? body['error'] : undefined;
  const rawMessage =
    err !== undefined && typeof err['message'] === 'string' ? err['message'] : response.text;
  return new ZgRouterError({
    status: response.status,
    type: err === undefined ? null : optString(err['type']),
    code: err === undefined ? null : optString(err['code']),
    message: sanitizeText(rawMessage === '' ? '(empty body)' : rawMessage),
    requestId: isRecord(body) ? optString(body['request_id']) : null,
    retryAfter: response.headers.get('retry-after'),
  });
}

// ── client ────────────────────────────────────────────────────────────────

export interface ZgRouterClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly managementKey?: string;
  readonly fetch?: FetchLike;
  /** Inference timeout; catalog/account calls use 15 s. */
  readonly chatTimeoutMs?: number;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ZgMessage[];
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly verifyTee?: boolean;
  /** JSON mode (documented as {"type": "json_object"}); send only if the model lists response_format. */
  readonly responseFormat?: 'json_object';
  /** e.g. { enable_thinking: false }; send only if the model lists chat_template_kwargs. */
  readonly chatTemplateKwargs?: Readonly<Record<string, string | number | boolean>>;
  /** Overrides the client's inference timeout for this call. */
  readonly timeoutMs?: number;
}

export interface ChatResult {
  readonly completion: ZgChatCompletion;
  /** `ZG-Res-Key` header (chat ID for independent TEE verification), if sent. */
  readonly zgResKey: string | null;
  readonly httpStatus: number;
  /** Raw response body, for evidence. Contains no credentials. */
  readonly raw: unknown;
}

export interface TranscriptionRequest {
  readonly model: string;
  readonly audio: Uint8Array;
  /** e.g. audio/webm; sent as the file part's type. */
  readonly mimeType: string;
  /** File name for the part (its extension helps the provider detect the format). */
  readonly filename: string;
  /** ISO-639-1, e.g. "en". */
  readonly language?: string;
  readonly verifyTee?: boolean;
  readonly timeoutMs?: number;
}

export interface TranscriptionResult {
  readonly transcription: ZgTranscription;
  /** `ZG-Res-Key` header, if sent. */
  readonly zgResKey: string | null;
  readonly httpStatus: number;
}

export class ZgRouterClient {
  readonly baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #managementKey: string | undefined;
  readonly #fetch: FetchLike | undefined;
  readonly #chatTimeoutMs: number;

  constructor(options: ZgRouterClientOptions) {
    if (!options.baseUrl.startsWith('https://'))
      throw new Error('0G Router base URL must be https');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#managementKey = options.managementKey;
    this.#fetch = options.fetch;
    this.#chatTimeoutMs = options.chatTimeoutMs ?? 90_000;
  }

  get hasManagementKey(): boolean {
    return this.#managementKey !== undefined;
  }

  #http(timeoutMs: number) {
    return this.#fetch === undefined ? { timeoutMs } : { timeoutMs, fetch: this.#fetch };
  }

  async listModels(): Promise<{ models: ZgModel[]; raw: unknown }> {
    const res = await sendJson(`${this.baseUrl}/models`, { method: 'GET' }, this.#http(15_000));
    if (res.status !== 200) throw routerErrorFrom(res);
    return { models: parseModelList(res.body), raw: res.body };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    if (this.#apiKey === undefined) throw new Error('an sk- API key is required for inference');
    const res = await sendJson(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#apiKey}` },
        json: {
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxTokens,
          stream: false,
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.verifyTee === true ? { verify_tee: true } : {}),
          ...(request.responseFormat === undefined
            ? {}
            : { response_format: { type: request.responseFormat } }),
          ...(request.chatTemplateKwargs === undefined
            ? {}
            : { chat_template_kwargs: request.chatTemplateKwargs }),
        },
      },
      this.#http(request.timeoutMs ?? this.#chatTimeoutMs),
    );
    if (res.status !== 200) throw routerErrorFrom(res);
    return {
      completion: parseChatCompletion(res.body),
      zgResKey: res.headers.get('zg-res-key'),
      httpStatus: res.status,
      raw: res.body,
    };
  }

  /** One speech-to-text call. Never retried (a replay would be billed twice). */
  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    if (this.#apiKey === undefined) throw new Error('an sk- API key is required for inference');
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType }),
      request.filename,
    );
    form.append('model', request.model);
    form.append('response_format', 'json');
    if (request.language !== undefined) form.append('language', request.language);
    const query = request.verifyTee === true ? '?verify_tee=true' : '';
    const res = await sendJson(
      `${this.baseUrl}/audio/transcriptions${query}`,
      { method: 'POST', headers: { authorization: `Bearer ${this.#apiKey}` }, form },
      this.#http(request.timeoutMs ?? this.#chatTimeoutMs),
    );
    if (res.status !== 200) throw routerErrorFrom(res);
    return {
      transcription: parseTranscription(res.body),
      zgResKey: res.headers.get('zg-res-key'),
      httpStatus: res.status,
    };
  }

  async #account(path: string): Promise<RawResponse> {
    if (this.#managementKey === undefined) {
      throw new Error('an mk- management key with scope account:read is required');
    }
    const res = await sendJson(
      `${this.baseUrl}/account/${path}`,
      { method: 'GET', headers: { authorization: `Bearer ${this.#managementKey}` } },
      this.#http(15_000),
    );
    if (res.status !== 200) throw routerErrorFrom(res);
    return res;
  }

  async getBalance(): Promise<ZgBalance> {
    return parseBalance((await this.#account('balance')).body);
  }

  /** The /account/balance body exactly as returned (diagnostics; contains no credentials). */
  async getBalanceRaw(): Promise<unknown> {
    return (await this.#account('balance')).body;
  }

  /** Recent usage entries, returned raw: the history schema is not documented field by field. */
  async getUsageHistory(limit = 10): Promise<unknown> {
    return (await this.#account(`usage/history?limit=${Math.max(1, Math.min(limit, 50))}`)).body;
  }
}
