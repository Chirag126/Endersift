/**
 * ed25519 keys in NEAR's text form ("ed25519:<base58>"), using node:crypto.
 * The secret never leaves this object: it is not enumerable, not printed and
 * not part of any error.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { base58Decode, base58Encode } from './base58.ts';

/** PKCS#8 header for an ed25519 private key; the 32-byte seed follows. */
const PKCS8_ED25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface NearSigner {
  /** "ed25519:<base58>" public key. */
  readonly publicKey: string;
  /** The raw 32-byte public key. */
  readonly publicKeyBytes: Uint8Array;
  /** ed25519 signature (64 bytes) of the message. */
  sign(message: Uint8Array): Uint8Array;
}

/** "ed25519:<base58>" → the raw 32 bytes. */
export function publicKeyBytes(publicKey: string): Uint8Array {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(publicKey);
  if (m === null) throw new Error('public key must be ed25519:<base58>');
  const bytes = base58Decode(m[1] ?? '');
  if (bytes.length !== 32) throw new Error('public key must be 32 bytes');
  return bytes;
}

/**
 * A signer from NEAR's secret key text: "ed25519:<base58>" of 64 bytes (seed
 * then public key, as near-cli writes it) or of the 32-byte seed alone.
 */
export function signerFromSecretKey(secretKey: string): NearSigner {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{43,88})$/.exec(secretKey.trim());
  if (m === null) throw new Error('secret key must be ed25519:<base58>');
  const raw = base58Decode(m[1] ?? '');
  if (raw.length !== 64 && raw.length !== 32) throw new Error('secret key must be 32 or 64 bytes');
  const der = new Uint8Array(PKCS8_ED25519.length + 32);
  der.set(PKCS8_ED25519, 0);
  der.set(raw.subarray(0, 32), PKCS8_ED25519.length);
  const key: KeyObject = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  const pub = Uint8Array.from(spki.subarray(spki.length - 32));
  if (raw.length === 64 && !raw.subarray(32).every((b, i) => b === pub[i]))
    throw new Error('secret key does not match its public key');
  const signer: NearSigner = {
    publicKey: `ed25519:${base58Encode(pub)}`,
    publicKeyBytes: pub,
    sign: (message) => Uint8Array.from(sign(null, message, key)),
  };
  return Object.freeze(signer);
}

/**
 * A new ed25519 key pair in NEAR's text form. The secret is returned once, to
 * be written to a local file that is never committed.
 */
export function generateKeyPair(): { readonly publicKey: string; readonly secretKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const seed = Uint8Array.from(pkcs8.subarray(pkcs8.length - 32));
  const pub = Uint8Array.from(spki.subarray(spki.length - 32));
  const both = new Uint8Array(64);
  both.set(seed, 0);
  both.set(pub, 32);
  return {
    publicKey: `ed25519:${base58Encode(pub)}`,
    secretKey: `ed25519:${base58Encode(both)}`,
  };
}
