/**
 * NEAR JSON-RPC client (plain fetch, no SDK).
 *
 * Methods used (docs.near.org/api/rpc, read 2026-11-12):
 *  - query view_account           → amount, code_hash, storage_usage
 *  - query view_access_key        → nonce, permission, block_hash
 *  - query view_access_key_list   → every key with its nonce and permission
 *  - query call_function          → a contract view call (result is JSON bytes)
 *  - block { finality: "final" }  → height, hash, timestamp
 *  - send_tx { signed_tx_base64, wait_until } → the transaction's outcome
 *
 * Everything that comes back is untrusted: each field is checked before use.
 * This client never retries a send: a replayed payment is the caller's
 * decision. Reads are safe to repeat.
 */
import { isAccountId, parseYocto } from './units.ts';

export type FetchLike = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/** The code hash of an account with no contract. */
export const NO_CONTRACT_HASH = '11111111111111111111111111111111';

export interface NearAccount {
  readonly amount: bigint;
  /** Base58 code hash, or null when the account has no contract. */
  readonly codeHash: string | null;
  readonly storageUsage: number;
}

export type KeyPermission =
  | { readonly kind: 'fullAccess' }
  | {
      readonly kind: 'functionCall';
      readonly receiverId: string;
      /** Empty = every method of the receiver. */
      readonly methodNames: readonly string[];
      /** Gas allowance left in yoctoNEAR, or null (unlimited). */
      readonly allowance: bigint | null;
    };

export interface NearAccessKey {
  readonly publicKey: string;
  readonly nonce: bigint;
  readonly permission: KeyPermission;
}

export interface NearHead {
  readonly height: number;
  readonly hash: string;
  readonly timestampMs: number;
}

export interface NearTxOutcome {
  readonly hash: string;
  readonly success: boolean;
  /** The JSON value the last receipt returned, or null (none, or not JSON). */
  readonly value: unknown;
  /** Why it failed: an ERR_* code from the contract when there is one, else a short description. */
  readonly failure: string | null;
  readonly logs: readonly string[];
}

export class NearRpcError extends Error {
  /** The RPC's error cause name (e.g. UNKNOWN_ACCOUNT, INVALID_TRANSACTION), or a transport code. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NearRpcError';
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Printable text only, cut to a length: RPC and contract text is untrusted. */
export function clean(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

function parsePermission(value: unknown): KeyPermission {
  if (value === 'FullAccess') return { kind: 'fullAccess' };
  const fc = isRecord(value) ? value['FunctionCall'] : undefined;
  if (!isRecord(fc)) throw new NearRpcError('BAD_RESPONSE', 'unknown access key permission');
  const receiverId = fc['receiver_id'];
  const names = fc['method_names'];
  if (!isAccountId(receiverId) || !Array.isArray(names))
    throw new NearRpcError('BAD_RESPONSE', 'malformed function-call permission');
  const allowance = fc['allowance'];
  return {
    kind: 'functionCall',
    receiverId,
    methodNames: names.filter((n): n is string => typeof n === 'string'),
    allowance: allowance === null || allowance === undefined ? null : parseYocto(allowance),
  };
}

function parseNonce(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value);
  throw new NearRpcError('BAD_RESPONSE', 'malformed nonce');
}

/** The reason inside a `Failure` status: the contract's ERR_* code when present. */
export function describeFailure(failure: unknown): string {
  const text = clean(failure, 2000);
  const code = /ERR_[A-Z_]{2,40}/.exec(text);
  if (code !== null) return code[0];
  // no contract code: flatten the structure to its words, e.g.
  // "TxExecutionError InvalidTxError InvalidAccessKeyError RequiresFullAccess"
  return text
    .replace(/[{}"[\]:,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function parseOutcome(result: unknown): NearTxOutcome {
  if (!isRecord(result)) throw new NearRpcError('BAD_RESPONSE', 'malformed transaction result');
  const tx = result['transaction'];
  const hash = isRecord(tx) && typeof tx['hash'] === 'string' ? tx['hash'] : '';
  const logs: string[] = [];
  const receipts = result['receipts_outcome'];
  let receiptFailure: unknown = null;
  if (Array.isArray(receipts))
    for (const r of receipts) {
      const outcome = isRecord(r) ? r['outcome'] : undefined;
      if (!isRecord(outcome)) continue;
      if (Array.isArray(outcome['logs']))
        for (const l of outcome['logs']) if (typeof l === 'string') logs.push(clean(l, 1000));
      const st = outcome['status'];
      if (receiptFailure === null && isRecord(st) && 'Failure' in st)
        receiptFailure = st['Failure'];
    }
  const status = result['status'];
  if (isRecord(status) && 'Failure' in status)
    return { hash, success: false, value: null, failure: describeFailure(status['Failure']), logs };
  if (isRecord(status) && typeof status['SuccessValue'] === 'string') {
    let value: unknown = null;
    try {
      const raw = Buffer.from(status['SuccessValue'], 'base64').toString('utf8');
      value = raw === '' ? null : (JSON.parse(raw) as unknown);
    } catch {
      value = null;
    }
    return { hash, success: true, value, failure: null, logs };
  }
  // no final status yet (wait_until too low): report what the receipts say
  return {
    hash,
    success: false,
    value: null,
    failure: receiptFailure === null ? 'outcome not final' : describeFailure(receiptFailure),
    logs,
  };
}

export interface NearRpcOptions {
  readonly url: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export class NearRpc {
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  #id = 0;

  constructor(options: NearRpcOptions) {
    this.#url = options.url;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async #call(method: string, params: unknown, timeoutMs = this.#timeoutMs): Promise<unknown> {
    this.#id += 1;
    let status: number;
    let text: string;
    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.#id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      throw new NearRpcError('TRANSPORT', `NEAR RPC ${method}: request failed (${name})`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      throw new NearRpcError('BAD_RESPONSE', `NEAR RPC ${method}: HTTP ${status}, not JSON`);
    }
    if (!isRecord(body))
      throw new NearRpcError('BAD_RESPONSE', `NEAR RPC ${method}: not an object`);
    const error = body['error'];
    if (isRecord(error)) {
      const cause = isRecord(error['cause']) ? error['cause'] : {};
      const code = typeof cause['name'] === 'string' ? cause['name'] : clean(error['name'], 60);
      const detail = describeFailure(error['data'] ?? error['message'] ?? cause['info'] ?? '');
      throw new NearRpcError(
        code === '' ? 'RPC_ERROR' : code,
        `NEAR RPC ${method}: ${code} ${detail}`,
      );
    }
    // older nodes answer a failed query with result.error
    const result = body['result'];
    if (isRecord(result) && typeof result['error'] === 'string')
      throw new NearRpcError('QUERY_ERROR', `NEAR RPC ${method}: ${clean(result['error'], 200)}`);
    return result;
  }

  /** The account, or null when it does not exist. */
  async viewAccount(accountId: string): Promise<NearAccount | null> {
    let result: unknown;
    try {
      result = await this.#call('query', {
        request_type: 'view_account',
        finality: 'final',
        account_id: accountId,
      });
    } catch (error) {
      if (error instanceof NearRpcError && error.code === 'UNKNOWN_ACCOUNT') return null;
      if (error instanceof NearRpcError && /does not exist/.test(error.message)) return null;
      throw error;
    }
    if (!isRecord(result) || typeof result['code_hash'] !== 'string')
      throw new NearRpcError('BAD_RESPONSE', 'malformed account');
    const usage = result['storage_usage'];
    return {
      amount: parseYocto(result['amount']),
      codeHash: result['code_hash'] === NO_CONTRACT_HASH ? null : clean(result['code_hash'], 64),
      storageUsage: typeof usage === 'number' && Number.isFinite(usage) ? usage : 0,
    };
  }

  /** Every access key of the account (empty when it has none or does not exist). */
  async accessKeys(accountId: string): Promise<NearAccessKey[]> {
    let result: unknown;
    try {
      result = await this.#call('query', {
        request_type: 'view_access_key_list',
        finality: 'final',
        account_id: accountId,
      });
    } catch (error) {
      if (error instanceof NearRpcError && error.code === 'UNKNOWN_ACCOUNT') return [];
      throw error;
    }
    const keys = isRecord(result) ? result['keys'] : undefined;
    if (!Array.isArray(keys)) throw new NearRpcError('BAD_RESPONSE', 'malformed access key list');
    const out: NearAccessKey[] = [];
    for (const k of keys) {
      if (!isRecord(k) || typeof k['public_key'] !== 'string' || !isRecord(k['access_key']))
        continue;
      out.push({
        publicKey: clean(k['public_key'], 80),
        nonce: parseNonce(k['access_key']['nonce']),
        permission: parsePermission(k['access_key']['permission']),
      });
    }
    return out;
  }

  /** One access key with a recent block hash to sign against, or null when the key is not on the account. */
  async accessKey(
    accountId: string,
    publicKey: string,
  ): Promise<(NearAccessKey & { readonly blockHash: string }) | null> {
    let result: unknown;
    try {
      result = await this.#call('query', {
        request_type: 'view_access_key',
        finality: 'final',
        account_id: accountId,
        public_key: publicKey,
      });
    } catch (error) {
      if (
        error instanceof NearRpcError &&
        (error.code === 'UNKNOWN_ACCESS_KEY' || error.code === 'UNKNOWN_ACCOUNT')
      )
        return null;
      if (error instanceof NearRpcError && /does not exist/.test(error.message)) return null;
      throw error;
    }
    if (!isRecord(result) || typeof result['block_hash'] !== 'string')
      throw new NearRpcError('BAD_RESPONSE', 'malformed access key');
    return {
      publicKey,
      nonce: parseNonce(result['nonce']),
      permission: parsePermission(result['permission']),
      blockHash: result['block_hash'],
    };
  }

  /** A contract view call. Returns the parsed JSON value (untrusted: check it). */
  async view(contractId: string, method: string, args: unknown = {}): Promise<unknown> {
    const result = await this.#call('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    const bytes = isRecord(result) ? result['result'] : undefined;
    if (!Array.isArray(bytes) || !bytes.every((b) => typeof b === 'number'))
      throw new NearRpcError('BAD_RESPONSE', `view ${method}: malformed result`);
    try {
      return JSON.parse(Buffer.from(bytes as number[]).toString('utf8')) as unknown;
    } catch {
      throw new NearRpcError('BAD_RESPONSE', `view ${method}: result is not JSON`);
    }
  }

  async head(): Promise<NearHead> {
    const result = await this.#call('block', { finality: 'final' });
    const header = isRecord(result) ? result['header'] : undefined;
    if (
      !isRecord(header) ||
      typeof header['height'] !== 'number' ||
      typeof header['hash'] !== 'string'
    )
      throw new NearRpcError('BAD_RESPONSE', 'malformed block header');
    const ns = header['timestamp_nanosec'];
    const timestampMs =
      typeof ns === 'string' && /^\d{1,24}$/.test(ns) ? Number(BigInt(ns) / 1_000_000n) : 0;
    return { height: header['height'], hash: header['hash'], timestampMs };
  }

  /**
   * Send a signed transaction and wait until every receipt has run
   * (EXECUTED_OPTIMISTIC) or is final (FINAL). Never retried here.
   */
  async sendTransaction(
    signedBase64: string,
    waitUntil: 'EXECUTED_OPTIMISTIC' | 'FINAL' = 'EXECUTED_OPTIMISTIC',
  ): Promise<NearTxOutcome> {
    const result = await this.#call(
      'send_tx',
      { signed_tx_base64: signedBase64, wait_until: waitUntil },
      Math.max(this.#timeoutMs, 60_000),
    );
    return parseOutcome(result);
  }
}
