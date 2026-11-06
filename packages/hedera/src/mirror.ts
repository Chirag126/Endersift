/**
 * Hedera Mirror Node REST client (read-only).
 *
 * The Mirror Node is our independent source of truth for account state and,
 * from Phase 20, for settlement verification. Responses are validated field
 * by field; anything unexpected is an error, never a silent default.
 */
import { HttpJsonError, getJson, isRecord, type JsonRequestOptions } from './http.ts';

const ENTITY_ID = /^0\.0\.\d+$/;

export type MirrorKeyType = 'ECDSA_SECP256K1' | 'ED25519' | 'ProtobufEncoded';

export interface MirrorAccount {
  readonly accountId: string;
  readonly balanceTinybars: bigint;
  readonly balanceTimestamp: string | null;
  readonly deleted: boolean;
  /** Public key as reported by the Mirror Node (hex), or null for complex keys. */
  readonly publicKey: string | null;
  readonly keyType: MirrorKeyType | null;
  readonly evmAddress: string | null;
  /** -1 means unlimited automatic token associations. */
  readonly maxAutomaticTokenAssociations: number;
  readonly memo: string;
}

export class MirrorNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MirrorNodeError';
  }
}

export function parseMirrorAccount(body: unknown): MirrorAccount {
  if (!isRecord(body)) throw new MirrorNodeError('account response is not an object');

  const accountId = body['account'];
  if (typeof accountId !== 'string' || !ENTITY_ID.test(accountId)) {
    throw new MirrorNodeError('account response has no valid "account" id');
  }

  const balance = body['balance'];
  if (!isRecord(balance) || typeof balance['balance'] !== 'number') {
    throw new MirrorNodeError('account response has no numeric balance.balance');
  }
  if (!Number.isSafeInteger(balance['balance']) || balance['balance'] < 0) {
    throw new MirrorNodeError('account balance is not a safe non-negative integer');
  }

  const key = body['key'];
  let publicKey: string | null = null;
  let keyType: MirrorKeyType | null = null;
  if (isRecord(key)) {
    const type = key['_type'];
    if (type === 'ECDSA_SECP256K1' || type === 'ED25519' || type === 'ProtobufEncoded') {
      keyType = type;
    }
    if (typeof key['key'] === 'string' && keyType !== 'ProtobufEncoded') {
      publicKey = key['key'].toLowerCase();
    }
  }

  const maxAuto = body['max_automatic_token_associations'];
  const evm = body['evm_address'];
  const memo = body['memo'];

  return {
    accountId,
    balanceTinybars: BigInt(balance['balance']),
    balanceTimestamp: typeof balance['timestamp'] === 'string' ? balance['timestamp'] : null,
    deleted: body['deleted'] === true,
    publicKey,
    keyType,
    evmAddress: typeof evm === 'string' ? evm : null,
    maxAutomaticTokenAssociations: typeof maxAuto === 'number' ? maxAuto : 0,
    memo: typeof memo === 'string' ? memo : '',
  };
}

export interface MirrorTransfer {
  readonly account: string;
  /** Signed tinybar amount (negative = debit). */
  readonly amount: bigint;
}

export interface MirrorTransaction {
  /** Mirror Node form, e.g. 0.0.7162784-1730000000-000000001. */
  readonly transactionId: string;
  readonly result: string;
  readonly name: string;
  readonly consensusTimestamp: string;
  readonly chargedTxFee: bigint;
  readonly transfers: readonly MirrorTransfer[];
  /**
   * Number of HTS token transfers in the transaction (Mirror Node `token_transfers`),
   * when the response carried the field. An HBAR payment must have none.
   */
  readonly tokenTransferCount?: number;
  /** The HTS token transfers themselves (Mirror Node `token_transfers`), when present. */
  readonly tokenTransfers?: readonly MirrorTokenTransfer[];
  /** True for the execution of a scheduled transaction (Mirror Node `scheduled`), when reported. */
  readonly scheduled?: boolean;
}

export interface MirrorTokenTransfer {
  readonly tokenId: string;
  readonly account: string;
  /** Signed amount in the token's smallest unit (negative = debit). */
  readonly amount: bigint;
}

/** Parse the first entry of a /api/v1/transactions/{id} response. */
export function parseMirrorTransaction(body: unknown): MirrorTransaction {
  const [first] = parseMirrorTransactions(body);
  if (first === undefined) throw new MirrorNodeError('transaction response is empty');
  return first;
}

/**
 * Parse EVERY entry of a /api/v1/transactions/{id} response. One transaction
 * ID can reach consensus more than once (a resubmitted duplicate is recorded
 * with result DUPLICATE_TRANSACTION next to the original), so reconciliation
 * must look at all of them, not just the first.
 */
export function parseMirrorTransactions(body: unknown): MirrorTransaction[] {
  if (!isRecord(body) || !Array.isArray(body['transactions'])) {
    throw new MirrorNodeError('transaction response has no transactions array');
  }
  return (body['transactions'] as unknown[]).map(parseEntry);
}

function parseEntry(first: unknown): MirrorTransaction {
  if (!isRecord(first)) throw new MirrorNodeError('transaction entry is not an object');

  const str = (key: string): string => {
    const value = first[key];
    if (typeof value !== 'string')
      throw new MirrorNodeError(`transaction field ${key} is not a string`);
    return value;
  };
  const fee = first['charged_tx_fee'];
  if (typeof fee !== 'number' || !Number.isSafeInteger(fee)) {
    throw new MirrorNodeError('transaction field charged_tx_fee is not an integer');
  }
  const rawTransfers = first['transfers'];
  if (!Array.isArray(rawTransfers)) throw new MirrorNodeError('transaction has no transfers array');
  const transfers = rawTransfers.map((t, i): MirrorTransfer => {
    if (!isRecord(t) || typeof t['account'] !== 'string' || typeof t['amount'] !== 'number') {
      throw new MirrorNodeError(`transfers[${i}] is malformed`);
    }
    if (!Number.isSafeInteger(t['amount']))
      throw new MirrorNodeError(`transfers[${i}].amount is unsafe`);
    return { account: t['account'], amount: BigInt(t['amount']) };
  });

  return {
    transactionId: str('transaction_id'),
    result: str('result'),
    name: str('name'),
    consensusTimestamp: str('consensus_timestamp'),
    chargedTxFee: BigInt(fee),
    transfers,
    ...(typeof first['scheduled'] === 'boolean' ? { scheduled: first['scheduled'] } : {}),
    ...(Array.isArray(first['token_transfers'])
      ? {
          tokenTransferCount: (first['token_transfers'] as unknown[]).length,
          tokenTransfers: (first['token_transfers'] as unknown[]).map(
            (t, i): MirrorTokenTransfer => {
              if (
                !isRecord(t) ||
                typeof t['token_id'] !== 'string' ||
                !ENTITY_ID.test(t['token_id']) ||
                typeof t['account'] !== 'string' ||
                typeof t['amount'] !== 'number' ||
                !Number.isSafeInteger(t['amount'])
              )
                throw new MirrorNodeError(`token_transfers[${i}] is malformed`);
              return { tokenId: t['token_id'], account: t['account'], amount: BigInt(t['amount']) };
            },
          ),
        }
      : {}),
  };
}

/** One HCS message as the Mirror Node reports it (/api/v1/topics/{id}/messages/{seq}). */
export interface MirrorTopicMessage {
  readonly topicId: string;
  readonly sequenceNumber: string;
  readonly consensusTimestamp: string;
  /** The message bytes, decoded from the Mirror Node's base64. */
  readonly message: Uint8Array;
  readonly runningHash: string;
  readonly payerAccountId: string | null;
}

export function parseMirrorTopicMessage(body: unknown): MirrorTopicMessage {
  if (!isRecord(body)) throw new MirrorNodeError('topic message is not an object');
  const str = (key: string): string => {
    const v = body[key];
    if (typeof v !== 'string')
      throw new MirrorNodeError(`topic message field ${key} is not a string`);
    return v;
  };
  const seq = body['sequence_number'];
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1)
    throw new MirrorNodeError('topic message sequence_number is not a positive integer');
  const b64 = str('message');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new MirrorNodeError('topic message is not base64');
  const payer = body['payer_account_id'];
  return {
    topicId: str('topic_id'),
    sequenceNumber: String(seq),
    consensusTimestamp: str('consensus_timestamp'),
    message: new Uint8Array(Buffer.from(b64, 'base64')),
    runningHash: str('running_hash'),
    payerAccountId: typeof payer === 'string' ? payer : null,
  };
}

/** A topic as the Mirror Node reports it (/api/v1/topics/{id}). */
/** A schedule entity as the Mirror Node reports it (/api/v1/schedules/{id}), D-066. */
export interface MirrorSchedule {
  readonly scheduleId: string;
  readonly creatorAccountId: string | null;
  readonly payerAccountId: string | null;
  readonly memo: string;
  readonly deleted: boolean;
  readonly waitForExpiry: boolean;
  /** Seconds.nanos; null when none was set. */
  readonly expirationTime: string | null;
  /** Seconds.nanos of the execution; null while it has not executed. */
  readonly executedTimestamp: string | null;
  readonly consensusTimestamp: string | null;
}

export function parseMirrorSchedule(body: unknown): MirrorSchedule {
  if (
    !isRecord(body) ||
    typeof body['schedule_id'] !== 'string' ||
    !ENTITY_ID.test(body['schedule_id'])
  )
    throw new MirrorNodeError('schedule response has no schedule_id');
  const opt = (key: string): string | null => {
    const v = body[key];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw new MirrorNodeError(`schedule field ${key} is not a string`);
    return v;
  };
  return {
    scheduleId: body['schedule_id'],
    creatorAccountId: opt('creator_account_id'),
    payerAccountId: opt('payer_account_id'),
    memo: typeof body['memo'] === 'string' ? body['memo'] : '',
    deleted: body['deleted'] === true,
    waitForExpiry: body['wait_for_expiry'] === true,
    expirationTime: opt('expiration_time'),
    executedTimestamp: opt('executed_timestamp'),
    consensusTimestamp: opt('consensus_timestamp'),
  };
}

export interface MirrorTopic {
  readonly topicId: string;
  readonly memo: string;
  readonly deleted: boolean;
  /** The submit key, if any ({ _type, key }), as reported. */
  readonly submitKey: { readonly type: string; readonly key: string } | null;
  readonly createdTimestamp: string | null;
}

export function parseMirrorTopic(body: unknown): MirrorTopic {
  if (!isRecord(body) || typeof body['topic_id'] !== 'string')
    throw new MirrorNodeError('topic response has no topic_id');
  const sk = body['submit_key'];
  const created = body['created_timestamp'];
  return {
    topicId: body['topic_id'],
    memo: typeof body['memo'] === 'string' ? body['memo'] : '',
    deleted: body['deleted'] === true,
    submitKey:
      isRecord(sk) && typeof sk['_type'] === 'string' && typeof sk['key'] === 'string'
        ? { type: sk['_type'], key: sk['key'] }
        : null,
    createdTimestamp: typeof created === 'string' ? created : null,
  };
}

export class MirrorNodeClient {
  readonly baseUrl: string;
  readonly #options: JsonRequestOptions;

  constructor(baseUrl: string, options: JsonRequestOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.#options = options;
  }

  async getAccount(accountId: string): Promise<MirrorAccount> {
    if (!ENTITY_ID.test(accountId)) throw new MirrorNodeError('invalid account id');
    const { body } = await getJson(
      `${this.baseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}`,
      this.#options,
    );
    const account = parseMirrorAccount(body);
    if (account.accountId !== accountId) {
      throw new MirrorNodeError(`Mirror Node returned ${account.accountId} for ${accountId}`);
    }
    return account;
  }

  /**
   * Look up a transaction by Mirror Node ID (0.0.N-seconds-nanos).
   * Returns null while the Mirror Node has not ingested it yet (HTTP 404).
   */
  async getTransaction(mirrorTransactionId: string): Promise<MirrorTransaction | null> {
    if (!/^0\.0\.\d+-\d+-\d+$/.test(mirrorTransactionId)) {
      throw new MirrorNodeError('invalid Mirror Node transaction id');
    }
    try {
      const { body } = await getJson(
        `${this.baseUrl}/api/v1/transactions/${encodeURIComponent(mirrorTransactionId)}`,
        this.#options,
      );
      return parseMirrorTransaction(body);
    } catch (error) {
      if (error instanceof HttpJsonError && error.status === 404) return null;
      throw error;
    }
  }

  /** Every consensus entry for a transaction ID ([] while the Mirror Node has none: HTTP 404). */
  async getTransactions(mirrorTransactionId: string): Promise<MirrorTransaction[]> {
    if (!/^0\.0\.\d+-\d+-\d+$/.test(mirrorTransactionId)) {
      throw new MirrorNodeError('invalid Mirror Node transaction id');
    }
    try {
      const { body } = await getJson(
        `${this.baseUrl}/api/v1/transactions/${encodeURIComponent(mirrorTransactionId)}`,
        this.#options,
      );
      return parseMirrorTransactions(body);
    } catch (error) {
      if (error instanceof HttpJsonError && error.status === 404) return [];
      throw error;
    }
  }

  /** A schedule entity, or null while the Mirror Node does not know it (HTTP 404). */
  async getSchedule(scheduleId: string): Promise<MirrorSchedule | null> {
    if (!ENTITY_ID.test(scheduleId)) throw new MirrorNodeError('invalid schedule id');
    try {
      const { body } = await getJson(
        `${this.baseUrl}/api/v1/schedules/${encodeURIComponent(scheduleId)}`,
        this.#options,
      );
      return parseMirrorSchedule(body);
    } catch (error) {
      if (error instanceof HttpJsonError && error.status === 404) return null;
      throw error;
    }
  }

  /** A topic, or null while the Mirror Node does not know it (HTTP 404). */
  async getTopic(topicId: string): Promise<MirrorTopic | null> {
    if (!ENTITY_ID.test(topicId)) throw new MirrorNodeError('invalid topic id');
    try {
      const { body } = await getJson(
        `${this.baseUrl}/api/v1/topics/${encodeURIComponent(topicId)}`,
        this.#options,
      );
      return parseMirrorTopic(body);
    } catch (error) {
      if (error instanceof HttpJsonError && error.status === 404) return null;
      throw error;
    }
  }

  /** One topic message by sequence number, or null while it is not ingested (HTTP 404). */
  async getTopicMessage(
    topicId: string,
    sequenceNumber: string,
  ): Promise<MirrorTopicMessage | null> {
    if (!ENTITY_ID.test(topicId)) throw new MirrorNodeError('invalid topic id');
    if (!/^[1-9]\d{0,18}$/.test(sequenceNumber))
      throw new MirrorNodeError('invalid sequence number');
    try {
      const { body } = await getJson(
        `${this.baseUrl}/api/v1/topics/${encodeURIComponent(topicId)}/messages/${sequenceNumber}`,
        this.#options,
      );
      const m = parseMirrorTopicMessage(body);
      if (m.topicId !== topicId || m.sequenceNumber !== sequenceNumber)
        throw new MirrorNodeError(`Mirror Node returned ${m.topicId}#${m.sequenceNumber}`);
      return m;
    } catch (error) {
      if (error instanceof HttpJsonError && error.status === 404) return null;
      throw error;
    }
  }

  /** The topic message written at a consensus timestamp (for reconciling an unknown submit). */
  async getTopicMessageAt(consensusTimestamp: string): Promise<MirrorTopicMessage | null> {
    if (!/^\d{1,12}\.\d{9}$/.test(consensusTimestamp))
      throw new MirrorNodeError('invalid consensus timestamp');
    try {
      const { body } = await getJson(
        `${this.baseUrl}/api/v1/topics/messages/${consensusTimestamp}`,
        this.#options,
      );
      return parseMirrorTopicMessage(body);
    } catch (error) {
      if (error instanceof HttpJsonError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Successful CRYPTOTRANSFER transactions touching an account with consensus
   * timestamps in [fromSeconds, toSeconds), oldest first (D-062). Follows the
   * Mirror Node's `links.next` only when it is a relative transactions path on
   * this Mirror Node, and throws past `maxPages`: a partial list must never
   * pass for a complete one.
   */
  async listAccountTransfers(
    accountId: string,
    fromSeconds: number,
    toSeconds: number,
    options: { maxPages?: number } = {},
  ): Promise<MirrorTransaction[]> {
    if (!ENTITY_ID.test(accountId)) throw new MirrorNodeError('invalid account id');
    if (!Number.isSafeInteger(fromSeconds) || !Number.isSafeInteger(toSeconds) || fromSeconds < 0)
      throw new MirrorNodeError('invalid time range');
    const query = new URLSearchParams([
      ['account.id', accountId],
      ['transactiontype', 'CRYPTOTRANSFER'],
      ['result', 'success'],
      ['timestamp', `gte:${fromSeconds}.000000000`],
      ['timestamp', `lt:${toSeconds}.000000000`],
      ['order', 'asc'],
      ['limit', '100'],
    ]);
    let path: string | null = `/api/v1/transactions?${query.toString()}`;
    const out: MirrorTransaction[] = [];
    const maxPages = options.maxPages ?? 20;
    for (let page = 0; path !== null; page += 1) {
      if (page >= maxPages)
        throw new MirrorNodeError(
          `more than ${maxPages} pages of transactions; refusing a partial list`,
        );
      const { body } = await getJson(`${this.baseUrl}${path}`, this.#options);
      out.push(...parseMirrorTransactions(body));
      path = nextTransactionsPath(body);
    }
    return out;
  }

  /** Poll until the transaction appears or the timeout elapses (Mirror Node lags consensus by seconds). */
  async waitForTransaction(
    mirrorTransactionId: string,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<MirrorTransaction | null> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    const interval = options.intervalMs ?? 2_000;
    for (;;) {
      const tx = await this.getTransaction(mirrorTransactionId);
      if (tx !== null) return tx;
      if (Date.now() + interval > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

/**
 * The Mirror Node's next-page link, if it is a relative /api/v1/transactions
 * path (untrusted input: anything else is refused, never followed elsewhere).
 */
export function nextTransactionsPath(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body['links'])) return null;
  const next = body['links']['next'];
  if (next === null || next === undefined) return null;
  if (typeof next !== 'string' || !/^\/api\/v1\/transactions\?[\w.=:&%-]+$/.test(next))
    throw new MirrorNodeError('links.next is not a Mirror Node transactions path');
  return next;
}

/** Public HashScan explorer link for an HCS topic. */
export function hashscanTopicUrl(network: 'testnet' | 'mainnet', topicId: string): string {
  return `https://hashscan.io/${network}/topic/${topicId}`;
}

/** Public HashScan explorer link for an account. */
export function hashscanAccountUrl(network: 'testnet' | 'mainnet', accountId: string): string {
  return `https://hashscan.io/${network}/account/${accountId}`;
}

/** Public HashScan explorer link for a transaction ID such as 0.0.123@1700000000.000000000. */
export function hashscanTransactionUrl(
  network: 'testnet' | 'mainnet',
  transactionId: string,
): string {
  return `https://hashscan.io/${network}/transaction/${encodeURIComponent(transactionId)}`;
}
