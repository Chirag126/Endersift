/**
 * Client for the Endersift spending guard contract (contracts/guard).
 *
 * GuardReader reads the registry, blocklist, caps and receipts (view calls,
 * no key). GuardAgent signs pay, attest and report with the agent's
 * function-call access key, and refuses to sign with anything else: a
 * full-access key, or a key scoped to another contract, stops it.
 *
 * Contract JSON is untrusted like any other input: every field is checked.
 */
import type { NearSigner } from './keys.ts';
import { NearRpcError, clean, isRecord, type KeyPermission, type NearRpc } from './rpc.ts';
import { jsonArgs, signTransaction } from './transaction.ts';
import { isAccountId, parseYocto } from './units.ts';

export interface GuardPolicy {
  readonly maxPerPayment: bigint;
  readonly maxPerRun: bigint;
  readonly maxPerDay: bigint;
  readonly maxPaymentsPerRun: number;
}

export interface GuardStatus {
  readonly owner: string;
  readonly agent: string;
  readonly paused: boolean;
  readonly policy: GuardPolicy;
  readonly spentToday: bigint;
  readonly balance: bigint;
  readonly providers: number;
  readonly receipts: number;
}

export interface GuardProvider {
  readonly accountId: string;
  readonly label: string;
  readonly endpoint: string;
  readonly description: string;
  /** The most one request may cost (yoctoNEAR). */
  readonly price: bigint;
  /** The contract code hash pinned at registration, or null (no contract). */
  readonly codeHash: string | null;
  readonly registeredAtMs: number;
  readonly blocked: boolean;
}

export interface GuardReport {
  readonly reporter: string;
  readonly reason: string;
  readonly evidence: string;
  readonly atMs: number;
}

export interface GuardReceipt {
  readonly id: number;
  readonly runId: string;
  readonly receiver: string;
  readonly amount: bigint;
  readonly memo: string;
  readonly status: 'Pending' | 'Paid' | 'Failed';
  /** The agent's check of the delivered work; null until it attests. */
  readonly passed: boolean | null;
  readonly atMs: number;
}

export interface GuardReceiverStats {
  readonly payments: number;
  readonly total: bigint;
  readonly passed: number;
  readonly failed: number;
  readonly firstPaidAtMs: number;
}

export interface GuardRunSpend {
  readonly spent: bigint;
  readonly payments: number;
}

function bad(what: string): never {
  throw new NearRpcError('BAD_RESPONSE', `guard contract: malformed ${what}`);
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) bad(what);
  return value;
}

function account(value: unknown, what: string): string {
  if (!isAccountId(value)) bad(what);
  return value;
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') bad(what);
  return clean(value, max);
}

function parsePolicy(value: unknown): GuardPolicy {
  if (!isRecord(value)) bad('policy');
  return {
    maxPerPayment: parseYocto(value['max_per_payment']),
    maxPerRun: parseYocto(value['max_per_run']),
    maxPerDay: parseYocto(value['max_per_day']),
    maxPaymentsPerRun: count(value['max_payments_per_run'], 'policy'),
  };
}

function parseProvider(accountId: string, value: unknown, blocked: boolean): GuardProvider {
  if (!isRecord(value)) bad('provider');
  const hash = text(value['code_hash'], 'provider', 64);
  return {
    accountId,
    label: text(value['label'], 'provider', 32),
    endpoint: text(value['endpoint'], 'provider', 256),
    description: text(value['description'], 'provider', 512),
    price: parseYocto(value['price']),
    codeHash: hash === '' ? null : hash,
    registeredAtMs: count(value['registered_at_ms'], 'provider'),
    blocked,
  };
}

function parseReceipt(value: unknown): GuardReceipt {
  if (!isRecord(value)) bad('receipt');
  const status = value['status'];
  if (status !== 'Pending' && status !== 'Paid' && status !== 'Failed') bad('receipt');
  const passed = value['passed'];
  if (passed !== null && passed !== undefined && typeof passed !== 'boolean') bad('receipt');
  return {
    id: count(value['id'], 'receipt'),
    runId: text(value['run_id'], 'receipt', 64),
    receiver: account(value['receiver'], 'receipt'),
    amount: parseYocto(value['amount']),
    memo: text(value['memo'], 'receipt', 512),
    status,
    passed: passed ?? null,
    atMs: count(value['at_ms'], 'receipt'),
  };
}

export class GuardReader {
  readonly contractId: string;
  readonly #rpc: NearRpc;

  constructor(rpc: NearRpc, contractId: string) {
    if (!isAccountId(contractId)) throw new Error('guard contract id is not a NEAR account id');
    this.#rpc = rpc;
    this.contractId = contractId;
  }

  async status(): Promise<GuardStatus> {
    const v = await this.#rpc.view(this.contractId, 'get_status');
    if (!isRecord(v) || typeof v['paused'] !== 'boolean') bad('status');
    return {
      owner: account(v['owner'], 'status'),
      agent: account(v['agent'], 'status'),
      paused: v['paused'],
      policy: parsePolicy(v['policy']),
      spentToday: parseYocto(v['spent_today']),
      balance: parseYocto(v['balance']),
      providers: count(v['providers'], 'status'),
      receipts: count(v['receipts'], 'status'),
    };
  }

  /** The registry: every provider the owner registered, with its block state. */
  async providers(): Promise<GuardProvider[]> {
    const v = await this.#rpc.view(this.contractId, 'get_providers');
    if (!Array.isArray(v)) bad('provider list');
    return v.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry['blocked'] !== 'boolean') bad('provider list');
      return parseProvider(
        account(entry['account_id'], 'provider list'),
        entry['provider'],
        entry['blocked'],
      );
    });
  }

  async provider(accountId: string): Promise<GuardProvider | null> {
    const [v, reports] = await Promise.all([
      this.#rpc.view(this.contractId, 'get_provider', { account_id: accountId }),
      this.reports(accountId),
    ]);
    return v === null ? null : parseProvider(accountId, v, reports.length > 0);
  }

  async reports(accountId: string): Promise<GuardReport[]> {
    const v = await this.#rpc.view(this.contractId, 'get_reports', { account_id: accountId });
    if (!Array.isArray(v)) bad('reports');
    return v.map((r: unknown) => {
      if (!isRecord(r)) bad('report');
      return {
        reporter: account(r['reporter'], 'report'),
        reason: text(r['reason'], 'report', 512),
        evidence: text(r['evidence'], 'report', 512),
        atMs: count(r['at_ms'], 'report'),
      };
    });
  }

  async receiverStats(accountId: string): Promise<GuardReceiverStats> {
    const v = await this.#rpc.view(this.contractId, 'get_receiver_stats', {
      account_id: accountId,
    });
    if (!isRecord(v)) bad('receiver stats');
    return {
      payments: count(v['payments'], 'receiver stats'),
      total: parseYocto(v['total']),
      passed: count(v['passed'], 'receiver stats'),
      failed: count(v['failed'], 'receiver stats'),
      firstPaidAtMs: count(v['first_paid_at_ms'], 'receiver stats'),
    };
  }

  async run(runId: string): Promise<GuardRunSpend> {
    const v = await this.#rpc.view(this.contractId, 'get_run', { run_id: runId });
    if (!isRecord(v)) bad('run');
    return { spent: parseYocto(v['spent']), payments: count(v['payments'], 'run') };
  }

  async receipt(id: number): Promise<GuardReceipt | null> {
    const v = await this.#rpc.view(this.contractId, 'get_receipt', { receipt_id: id });
    return v === null ? null : parseReceipt(v);
  }

  async receipts(from: number, limit: number): Promise<GuardReceipt[]> {
    const v = await this.#rpc.view(this.contractId, 'get_receipts', { from, limit });
    if (!Array.isArray(v)) bad('receipts');
    return v.map(parseReceipt);
  }
}

/** Why the agent refused to sign before anything was sent. */
export class GuardKeyError extends Error {
  readonly code: 'KEY_NOT_ON_ACCOUNT' | 'FULL_ACCESS_KEY' | 'KEY_FOR_ANOTHER_CONTRACT';
  constructor(code: GuardKeyError['code'], message: string) {
    super(message);
    this.name = 'GuardKeyError';
    this.code = code;
  }
}

export interface GuardCallResult {
  /** Base58 transaction hash. */
  readonly hash: string;
  readonly success: boolean;
  /** An ERR_* code from the contract, or a short description; null on success. */
  readonly failure: string | null;
  readonly logs: readonly string[];
}

export interface GuardPayResult extends GuardCallResult {
  /** The receipt the contract wrote, or null when the call was refused. */
  readonly receiptId: number | null;
}

export interface GuardAgentOptions {
  readonly rpc: NearRpc;
  readonly contractId: string;
  /** The agent's account: the one the guard contract knows as `agent`. */
  readonly accountId: string;
  /** The agent's function-call access key. */
  readonly signer: NearSigner;
}

const TGAS = 1_000_000_000_000n;
/** pay: the checks, the transfer and its callback. */
const PAY_GAS = 100n * TGAS;
const CALL_GAS = 30n * TGAS;

export class GuardAgent {
  readonly contractId: string;
  readonly accountId: string;
  readonly #rpc: NearRpc;
  readonly #signer: NearSigner;
  /** One transaction at a time: each needs the key's next nonce. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: GuardAgentOptions) {
    if (!isAccountId(options.contractId) || !isAccountId(options.accountId))
      throw new Error('guard contract id and agent account id must be NEAR account ids');
    this.#rpc = options.rpc;
    this.#signer = options.signer;
    this.contractId = options.contractId;
    this.accountId = options.accountId;
  }

  get publicKey(): string {
    return this.#signer.publicKey;
  }

  /**
   * The key's permission, after checking it is a function-call key scoped to
   * the guard contract. Anything else throws GuardKeyError and nothing is signed.
   */
  async scopedKey(): Promise<{
    readonly permission: Extract<KeyPermission, { kind: 'functionCall' }>;
    readonly nonce: bigint;
    readonly blockHash: string;
  }> {
    const key = await this.#rpc.accessKey(this.accountId, this.#signer.publicKey);
    if (key === null)
      throw new GuardKeyError('KEY_NOT_ON_ACCOUNT', 'the agent key is not on the agent account');
    if (key.permission.kind !== 'functionCall')
      throw new GuardKeyError(
        'FULL_ACCESS_KEY',
        'the agent key is a full-access key: the agent only signs with a function-call key',
      );
    if (key.permission.receiverId !== this.contractId)
      throw new GuardKeyError(
        'KEY_FOR_ANOTHER_CONTRACT',
        'the agent key is scoped to another contract than the guard',
      );
    return { permission: key.permission, nonce: key.nonce, blockHash: key.blockHash };
  }

  #call(method: string, args: unknown, gas: bigint): Promise<GuardCallResult & { value: unknown }> {
    const run = async () => {
      const key = await this.scopedKey();
      const signed = signTransaction(
        {
          signerId: this.accountId,
          publicKey: this.#signer.publicKeyBytes,
          nonce: key.nonce + 1n,
          receiverId: this.contractId,
          blockHash: key.blockHash,
          actions: [{ kind: 'functionCall', method, args: jsonArgs(args), gas, deposit: 0n }],
        },
        this.#signer,
      );
      const outcome = await this.#rpc.sendTransaction(signed.base64);
      return {
        hash: outcome.hash === '' ? signed.hash : outcome.hash,
        success: outcome.success,
        failure: outcome.failure,
        logs: outcome.logs,
        value: outcome.value,
      };
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** Ask the guard to pay a provider. The contract decides; a refusal comes back as `failure`. */
  async pay(request: {
    readonly runId: string;
    readonly receiver: string;
    readonly amount: bigint;
    readonly memo: string;
  }): Promise<GuardPayResult> {
    const { value, ...result } = await this.#call(
      'pay',
      {
        run_id: request.runId,
        receiver: request.receiver,
        amount: request.amount.toString(),
        memo: request.memo,
      },
      PAY_GAS,
    );
    const receiptId =
      result.success && typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
    return { ...result, receiptId };
  }

  /** Record whether the delivered work passed the agent's check. */
  async attest(receiptId: number, passed: boolean): Promise<GuardCallResult> {
    const { value: _value, ...result } = await this.#call(
      'attest',
      { receipt_id: receiptId, passed },
      CALL_GAS,
    );
    return result;
  }

  /** Report an account to the shared blocklist, with evidence. */
  async report(accountId: string, reason: string, evidence: string): Promise<GuardCallResult> {
    const { value: _value, ...result } = await this.#call(
      'report',
      { account_id: accountId, reason, evidence },
      CALL_GAS,
    );
    return result;
  }
}
