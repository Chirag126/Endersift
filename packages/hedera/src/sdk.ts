/**
 * The only module that touches the Hiero SDK.
 *
 * SDK primitives (PrivateKey, Client, Transaction, ...) are imported through
 * @x402/hedera, which re-exports them precisely so that applications resolve a
 * single SDK instance (duplicate installs break instanceof checks at runtime).
 * Only AccountCreateTransaction, which @x402/hedera does not re-export, comes
 * from @hiero-ledger/sdk directly, pinned to the same version (D-010, D-016).
 */
import {
  AccountCreateTransaction,
  PrecheckStatusError,
  ReceiptStatusError,
  ScheduleCreateTransaction,
  Timestamp,
  TopicCreateTransaction,
  TransferTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  TransactionId,
} from '@hiero-ledger/sdk';
import { AccountId, Client, Hbar, PrivateKey, Transaction } from '@x402/hedera';

export type KeyType = 'ecdsa' | 'ed25519';
export type HederaNetwork = 'testnet' | 'mainnet';

const DER_ECDSA_PREFIX = '3030020100300706052b8104000a04220420';
const DER_ED25519_PREFIX = '302e020100300506032b657004220420';

/** Parse a configured private key (raw hex with optional 0x, or DER hex). */
export function parsePrivateKey(value: string, type: KeyType): PrivateKey {
  const hex = value.trim().replace(/^0x/i, '');
  const lower = hex.toLowerCase();
  if (lower.startsWith(DER_ECDSA_PREFIX) || lower.startsWith(DER_ED25519_PREFIX)) {
    return PrivateKey.fromStringDer(lower);
  }
  return type === 'ecdsa' ? PrivateKey.fromStringECDSA(lower) : PrivateKey.fromStringED25519(lower);
}

/** Raw public key hex in the same encoding the Mirror Node reports (compressed for ECDSA). */
export function publicKeyHex(privateKey: PrivateKey): string {
  return privateKey.publicKey.toStringRaw().toLowerCase();
}

export function createClient(
  network: HederaNetwork,
  operatorId: string,
  operatorKey: PrivateKey,
): Client {
  const client = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(operatorId), operatorKey);
  return client;
}

export interface CreatedAccount {
  readonly accountId: string;
  readonly transactionId: string;
}

export interface CreateAccountOptions {
  readonly initialBalanceTinybars: bigint;
  readonly memo: string;
}

/** Generate a fresh ECDSA (secp256k1) key. Persist it before using it in a transaction. */
export function generateEcdsaKey(): PrivateKey {
  return PrivateKey.generateECDSA();
}

/**
 * Create a new account controlled by `key`, without an EVM alias, so it has an
 * ordinary 0.0.x identity (x402 facilitators reject alias-based account IDs).
 * Unlimited automatic token associations let it receive HTS tokens such as
 * testnet USDC later without a separate association transaction.
 *
 * The caller generates and persists the key first, so a crash between
 * submission and receipt can never leave a funded account with a lost key.
 */
export async function createAccount(
  client: Client,
  key: PrivateKey,
  options: CreateAccountOptions,
): Promise<CreatedAccount> {
  const response = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setInitialBalance(Hbar.fromTinybars(options.initialBalanceTinybars.toString()))
    .setMaxAutomaticTokenAssociations(-1)
    .setAccountMemo(options.memo)
    .execute(client);
  const transactionId = response.transactionId.toString();
  const receipt = await response.getReceipt(client);
  if (receipt.accountId === null) {
    throw new Error(`account creation ${transactionId} returned no account id`);
  }
  return { accountId: receipt.accountId.toString(), transactionId };
}

/**
 * Read the transaction ID from an x402 Hedera payment payload (base64-encoded,
 * partially signed TransferTransaction) BEFORE it is submitted. The ID is
 * generated from the facilitator's fee payer, so knowing it up front lets an
 * uncertain outcome be reconciled on the Mirror Node instead of re-paying.
 */
export function transactionIdFromPayload(transactionBase64: string): string {
  const tx = Transaction.fromBytes(Buffer.from(transactionBase64, 'base64'));
  // Widened on purpose: the SDK's typing of this getter differs across versions.
  const id = tx.transactionId as { toString(): string } | null | undefined;
  if (id === null || id === undefined) throw new Error('payment transaction has no transaction ID');
  return id.toString();
}

// ── HCS audit topic (plan row 29, D-057) ──────────────────────────────────

/**
 * The most a topic message may cost (0.1 HBAR); a higher network fee fails
 * instead. An HCS message is priced at about USD 0.0001, far below this.
 */
export const TOPIC_MAX_FEE_TINYBARS = 10_000_000n;
/**
 * The most the one-time topic creation may cost (5 HBAR). It is priced at
 * about USD 0.01 plus the submit key, which at a low HBAR price is more than
 * 0.1 HBAR: the first live attempt was refused with INSUFFICIENT_TX_FEE.
 * The network charges the real fee, not this cap.
 */
export const TOPIC_CREATE_MAX_FEE_TINYBARS = 500_000_000n;

/**
 * The Hedera status when an error certainly means "not recorded": refused at
 * precheck, or reached consensus and failed (receipt). null for anything else
 * (timeouts, lost connections), whose outcome is unknown. The SDK's status
 * errors are all named "StatusError" and its build is minified, so the class
 * is checked with instanceof, not by name.
 */
export function definiteFailureStatus(error: unknown): string | null {
  if (error instanceof PrecheckStatusError || error instanceof ReceiptStatusError)
    return error.status.toString();
  return null;
}
/** HCS messages above this need chunking; audit messages are kept to one chunk. */
export const TOPIC_MESSAGE_MAX_BYTES = 1024;

export interface CreatedTopic {
  readonly topicId: string;
  readonly transactionId: string;
}

/**
 * Create the audit topic. Only `submitKey` may post to it (the payer), and it
 * has no admin key, so nobody can change or delete it: the record is
 * permanent. The SDK makes the operator the auto-renew account.
 */
export async function createTopic(
  client: Client,
  options: { readonly memo: string; readonly submitKey: PrivateKey },
): Promise<CreatedTopic> {
  const response = await new TopicCreateTransaction()
    .setTopicMemo(options.memo)
    .setSubmitKey(options.submitKey.publicKey)
    .setMaxTransactionFee(Hbar.fromTinybars(TOPIC_CREATE_MAX_FEE_TINYBARS.toString()))
    .execute(client);
  const transactionId = response.transactionId.toString();
  const receipt = await response.getReceipt(client);
  if (receipt.topicId === null)
    throw new Error(`topic create ${transactionId}: no topic ID in receipt`);
  return { topicId: receipt.topicId.toString(), transactionId };
}

/** A fresh transaction ID for the operator, to be persisted before the submit (no blind resend). */
export function newTransactionId(client: Client): string {
  const operator = client.operatorAccountId;
  if (operator === null) throw new Error('the client has no operator');
  return TransactionId.generate(operator).toString();
}

export interface SubmittedMessage {
  readonly transactionId: string;
  readonly sequenceNumber: string;
}

/**
 * Post one single-chunk message under a transaction ID chosen (and recorded)
 * by the caller. Throws on any failure; the caller decides from the recorded
 * transaction ID what happened, on the Mirror Node, without resubmitting.
 */
export async function submitTopicMessage(
  client: Client,
  options: {
    readonly topicId: string;
    readonly message: Uint8Array;
    readonly transactionId: string;
  },
): Promise<SubmittedMessage> {
  if (options.message.length > TOPIC_MESSAGE_MAX_BYTES)
    throw new Error(
      `audit message is ${options.message.length} bytes; at most ${TOPIC_MESSAGE_MAX_BYTES}`,
    );
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(options.topicId))
    .setMessage(options.message)
    .setMaxChunks(1)
    .setTransactionId(TransactionId.fromString(options.transactionId))
    .setMaxTransactionFee(Hbar.fromTinybars(TOPIC_MAX_FEE_TINYBARS.toString()))
    .execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.topicSequenceNumber === null)
    throw new Error(`topic message ${options.transactionId}: no sequence number in receipt`);
  return {
    transactionId: response.transactionId.toString(),
    sequenceNumber: receipt.topicSequenceNumber.toString(),
  };
}

// ── Scheduled Transactions (D-066) ────────────────────────────────────────

export interface ScheduledTransfer {
  readonly scheduleId: string;
  /** The ScheduleCreate transaction itself. */
  readonly createTransactionId: string;
  /** The transfer that will execute (`…?scheduled`), for the Mirror Node lookup later. */
  readonly scheduledTransactionId: string;
}

/**
 * Schedule one HBAR transfer from the operator to `to`, executed by the
 * network at `executeAt` (HIP-423 long-term schedule: wait_for_expiry), not
 * before. The operator signs the ScheduleCreate, and that signature also
 * satisfies the transfer, so nothing else needs to sign. The operator's key
 * is the schedule's admin key, so it can still be cancelled before it runs.
 */
export async function scheduleTransfer(
  client: Client,
  options: {
    readonly from: string;
    readonly to: string;
    readonly tinybars: bigint;
    readonly executeAt: Date;
    readonly memo: string;
    readonly adminKey: PrivateKey;
  },
): Promise<ScheduledTransfer> {
  const transfer = new TransferTransaction()
    .addHbarTransfer(options.from, Hbar.fromTinybars((-options.tinybars).toString()))
    .addHbarTransfer(options.to, Hbar.fromTinybars(options.tinybars.toString()));
  const response = await new ScheduleCreateTransaction()
    .setScheduledTransaction(transfer)
    .setExpirationTime(Timestamp.fromDate(options.executeAt))
    .setWaitForExpiry(true)
    .setScheduleMemo(options.memo)
    .setAdminKey(options.adminKey.publicKey)
    .execute(client);
  const createTransactionId = response.transactionId.toString();
  const receipt = await response.getReceipt(client);
  if (receipt.scheduleId === null || receipt.scheduledTransactionId === null)
    throw new Error(`schedule create ${createTransactionId}: no schedule ID in the receipt`);
  return {
    scheduleId: receipt.scheduleId.toString(),
    createTransactionId,
    scheduledTransactionId: receipt.scheduledTransactionId.toString(),
  };
}
