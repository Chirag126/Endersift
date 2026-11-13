/**
 * NEAR transactions, serialised with Borsh by hand (nomicon: Transactions).
 * Only the two actions the agent side needs: FunctionCall and Transfer. Pure
 * apart from signing.
 *
 *   Transaction { signer_id, public_key, nonce: u64, receiver_id,
 *                 block_hash: [u8; 32], actions: Vec<Action> }
 *   Action      enum index 2 = FunctionCall { method_name, args, gas: u64, deposit: u128 }
 *               enum index 3 = Transfer { deposit: u128 }
 *   SignedTransaction { transaction, signature }
 *
 * The signature is ed25519 over sha256(borsh(transaction)); that hash, in
 * base58, is the transaction hash.
 */
import { createHash } from 'node:crypto';
import { base58Decode, base58Encode } from './base58.ts';
import type { NearSigner } from './keys.ts';

export type NearAction =
  | {
      readonly kind: 'functionCall';
      readonly method: string;
      readonly args: Uint8Array;
      readonly gas: bigint;
      readonly deposit: bigint;
    }
  | { readonly kind: 'transfer'; readonly deposit: bigint };

export interface NearTransaction {
  readonly signerId: string;
  readonly publicKey: Uint8Array;
  readonly nonce: bigint;
  readonly receiverId: string;
  /** Base58 hash of a recent block (the transaction is valid for about a day after it). */
  readonly blockHash: string;
  readonly actions: readonly NearAction[];
}

class Writer {
  #parts: Uint8Array[] = [];
  u8(v: number): void {
    this.#parts.push(Uint8Array.of(v));
  }
  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.#parts.push(b);
  }
  uint(v: bigint, bytes: number): void {
    if (v < 0n || v >= 1n << BigInt(bytes * 8)) throw new Error('integer out of range');
    const b = new Uint8Array(bytes);
    let n = v;
    for (let i = 0; i < bytes; i += 1) {
      b[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    this.#parts.push(b);
  }
  bytes(v: Uint8Array): void {
    this.#parts.push(v);
  }
  vec(v: Uint8Array): void {
    this.u32(v.length);
    this.#parts.push(v);
  }
  text(v: string): void {
    this.vec(new TextEncoder().encode(v));
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.#parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.#parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

export function encodeTransaction(tx: NearTransaction): Uint8Array {
  if (tx.publicKey.length !== 32) throw new Error('public key must be 32 bytes');
  const blockHash = base58Decode(tx.blockHash);
  if (blockHash.length !== 32) throw new Error('block hash must be 32 bytes');
  const w = new Writer();
  w.text(tx.signerId);
  w.u8(0); // key type: ed25519
  w.bytes(tx.publicKey);
  w.uint(tx.nonce, 8);
  w.text(tx.receiverId);
  w.bytes(blockHash);
  w.u32(tx.actions.length);
  for (const a of tx.actions) {
    if (a.kind === 'functionCall') {
      w.u8(2);
      w.text(a.method);
      w.vec(a.args);
      w.uint(a.gas, 8);
      w.uint(a.deposit, 16);
    } else {
      w.u8(3);
      w.uint(a.deposit, 16);
    }
  }
  return w.done();
}

export interface SignedNearTransaction {
  /** Base58 transaction hash. */
  readonly hash: string;
  /** Base64 of the Borsh SignedTransaction, as the RPC takes it. */
  readonly base64: string;
}

export function signTransaction(tx: NearTransaction, signer: NearSigner): SignedNearTransaction {
  const body = encodeTransaction(tx);
  const hash = Uint8Array.from(createHash('sha256').update(body).digest());
  const signature = signer.sign(hash);
  if (signature.length !== 64) throw new Error('signature must be 64 bytes');
  const w = new Writer();
  w.bytes(body);
  w.u8(0); // signature type: ed25519
  w.bytes(signature);
  return { hash: base58Encode(hash), base64: Buffer.from(w.done()).toString('base64') };
}

/** JSON arguments for a contract call. */
export function jsonArgs(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
