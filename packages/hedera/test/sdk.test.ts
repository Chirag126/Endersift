// Class: unit (offline). Exercises @hiero-ledger/sdk key handling with freshly
// generated keys; no network access and no transactions.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HEDERA_DER_PREFIX, detectHederaKeyEncoding } from '../../core/src/index.ts';
import { generateEcdsaKey, parsePrivateKey, publicKeyHex } from '../src/sdk.ts';

describe('SDK key handling', () => {
  it('generates ECDSA keys whose DER form our validators recognise', () => {
    const key = generateEcdsaKey();
    const der = key.toStringDer().toLowerCase();
    assert.ok(der.startsWith(HEDERA_DER_PREFIX.ecdsa));
    assert.equal(detectHederaKeyEncoding(der), 'ecdsa');
  });

  it('derives a compressed 33-byte secp256k1 public key (Mirror Node encoding)', () => {
    const hex = publicKeyHex(generateEcdsaKey());
    assert.match(hex, /^0[23][0-9a-f]{64}$/);
  });

  it('parses raw hex, 0x-prefixed hex and DER to the same key', () => {
    const key = generateEcdsaKey();
    const expected = publicKeyHex(key);
    const raw = key.toStringRaw();
    for (const form of [raw, `0x${raw}`, key.toStringDer()]) {
      assert.equal(publicKeyHex(parsePrivateKey(form, 'ecdsa')), expected);
    }
  });
});
