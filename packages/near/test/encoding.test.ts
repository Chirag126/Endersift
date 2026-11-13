import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  base58Decode,
  base58Encode,
  encodeTransaction,
  formatNear,
  isAccountId,
  jsonArgs,
  parseNear,
  parseYocto,
  publicKeyBytes,
  signTransaction,
  signerFromSecretKey,
} from '../src/index.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const fromHex = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));

// RFC 8032, section 7.1, test 1
const SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const SIGNATURE_OF_EMPTY =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

describe('base58', () => {
  it('round-trips bytes, keeping leading zeros', () => {
    for (const h of ['', '00', '0000ff', 'ff', PUBLIC, '00' + PUBLIC])
      assert.equal(hex(base58Decode(base58Encode(fromHex(h)))), h);
  });
  it('encodes 32 zero bytes as 32 ones (the "no contract" code hash)', () => {
    assert.equal(base58Encode(new Uint8Array(32)), '1'.repeat(32));
    assert.equal(base58Decode('1'.repeat(32)).length, 32);
  });
  it('matches a known value', () => {
    assert.equal(base58Encode(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
  });
  it('rejects characters outside the alphabet', () => {
    assert.throws(() => base58Decode('0OIl'), /not base58/);
  });
});

describe('NEAR amounts', () => {
  it('parses and formats exactly', () => {
    assert.equal(parseNear('1'), 10n ** 24n);
    assert.equal(parseNear('0.005'), 5n * 10n ** 21n);
    assert.equal(parseNear('0.000000000000000000000001'), 1n);
    assert.equal(formatNear(5n * 10n ** 21n), '0.005');
    assert.equal(formatNear(10n ** 24n), '1');
    assert.equal(formatNear(0n), '0');
    assert.equal(formatNear(1n), '0.000000000000000000000001');
  });
  it('rejects signs, exponents and too many decimals', () => {
    for (const bad of ['-1', '1e3', '1.0000000000000000000000001', '', 'abc', '1.'])
      assert.throws(() => parseNear(bad), /not a NEAR amount/);
  });
  it('reads yoctoNEAR strings only', () => {
    assert.equal(parseYocto('1000'), 1000n);
    for (const bad of [1000, '-1', '1.5', '', null]) assert.throws(() => parseYocto(bad));
  });
  it('knows NEAR account ids', () => {
    for (const ok of ['kev.endersift.testnet', 'a-b_c.near', 'ab', 'f'.repeat(64)])
      assert.ok(isAccountId(ok), ok);
    for (const bad of ['A.near', 'a', 'a..b', '-a.near', 'a b', 'f'.repeat(65), 5])
      assert.ok(!isAccountId(bad), String(bad));
  });
});

describe('keys', () => {
  const secret64 = `ed25519:${base58Encode(fromHex(SEED + PUBLIC))}`;
  const secret32 = `ed25519:${base58Encode(fromHex(SEED))}`;

  it('derives the public key and signs (RFC 8032 test 1)', () => {
    for (const secret of [secret64, secret32]) {
      const signer = signerFromSecretKey(secret);
      assert.equal(hex(signer.publicKeyBytes), PUBLIC);
      assert.equal(signer.publicKey, `ed25519:${base58Encode(fromHex(PUBLIC))}`);
      assert.equal(hex(signer.sign(new Uint8Array(0))), SIGNATURE_OF_EMPTY);
      assert.equal(hex(publicKeyBytes(signer.publicKey)), PUBLIC);
    }
  });
  it('rejects a secret whose public half does not match', () => {
    const wrong = `ed25519:${base58Encode(fromHex(SEED + '00'.repeat(32)))}`;
    assert.throws(() => signerFromSecretKey(wrong), /does not match/);
  });
  it('never puts the secret in an error or in the signer', () => {
    const signer = signerFromSecretKey(secret64);
    assert.ok(!JSON.stringify(signer).includes(base58Encode(fromHex(SEED))));
    assert.throws(
      () => signerFromSecretKey('ed25519:not-base58-!!'),
      (error: Error) => !error.message.includes('not-base58'),
    );
  });
});

describe('transactions', () => {
  const blockHash = base58Encode(fromHex('ab'.repeat(32)));
  const tx = {
    signerId: 'agent.testnet',
    publicKey: fromHex(PUBLIC),
    nonce: 0x0102030405n,
    receiverId: 'guard.testnet',
    blockHash,
    actions: [
      {
        kind: 'functionCall' as const,
        method: 'pay',
        args: jsonArgs({ a: 1 }),
        gas: 100_000_000_000_000n,
        deposit: 0n,
      },
    ],
  };

  it('serialises a function call in Borsh, field by field', () => {
    const expected =
      '0d000000' +
      hex(new TextEncoder().encode('agent.testnet')) + // signer_id
      '00' +
      PUBLIC + // public key: ed25519
      '0504030201000000' + // nonce, u64 little-endian
      '0d000000' +
      hex(new TextEncoder().encode('guard.testnet')) + // receiver_id
      'ab'.repeat(32) + // block hash
      '01000000' + // one action
      '02' + // FunctionCall
      '03000000' +
      hex(new TextEncoder().encode('pay')) +
      '07000000' +
      hex(new TextEncoder().encode('{"a":1}')) +
      '00407a10f35a0000' + // 100 Tgas, u64 little-endian
      '00'.repeat(16); // deposit, u128
    assert.equal(hex(encodeTransaction(tx)), expected);
  });

  it('serialises a transfer', () => {
    const bytes = encodeTransaction({
      ...tx,
      actions: [{ kind: 'transfer', deposit: 10n ** 24n }],
    });
    assert.equal(hex(bytes).slice(-34), '03' + '000000a1edccce1bc2d3' + '00'.repeat(6));
  });

  it('signs sha256 of the transaction; the hash is the transaction hash', () => {
    const signer = signerFromSecretKey(`ed25519:${base58Encode(fromHex(SEED + PUBLIC))}`);
    const signed = signTransaction(tx, signer);
    const raw = Buffer.from(signed.base64, 'base64');
    const body = encodeTransaction(tx);
    assert.equal(hex(raw.subarray(0, body.length)), hex(body));
    assert.equal(raw[body.length], 0);
    const signature = raw.subarray(body.length + 1);
    assert.equal(signature.length, 64);
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(PUBLIC, 'hex'),
      ]),
      format: 'der',
      type: 'spki',
    });
    assert.ok(verify(null, base58Decode(signed.hash), key, signature));
    assert.equal(base58Decode(signed.hash).length, 32);
  });

  it('rejects out-of-range integers and malformed hashes', () => {
    assert.throws(() => encodeTransaction({ ...tx, nonce: -1n }), /out of range/);
    assert.throws(() => encodeTransaction({ ...tx, nonce: 1n << 64n }), /out of range/);
    assert.throws(() => encodeTransaction({ ...tx, blockHash: 'abc' }), /32 bytes/);
  });
});
