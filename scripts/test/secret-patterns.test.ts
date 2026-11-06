import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALLOW_MARKER, looksBinary, scanText } from '../lib/secret-patterns.ts';

// Fake secrets are assembled at runtime so no secret-shaped literal is committed.
const HEX32 = 'cd'.repeat(32);
const DER_ECDSA = ['3030020100300706052b81', '04000a04220420'].join('') + HEX32;
const DER_ED25519 = ['302e020100300506032b65', '7004220420'].join('') + HEX32;

const rules = (text: string) => scanText(text).map((f) => f.ruleId);

describe('scanText', () => {
  it('flags DER-encoded Hedera private keys anywhere', () => {
    assert.deepEqual(rules(`const k = "${DER_ECDSA}"`), ['hedera-der-private-key']);
    assert.ok(rules(`key=${DER_ED25519}`).includes('hedera-der-private-key'));
  });

  it('flags credential variables assigned literal values', () => {
    assert.ok(
      rules('ZG_API_KEY=' + 'sk-live-' + 'abcdefghijklmnop').includes('assigned-credential'),
    );
    assert.ok(rules(`HEDERA_PAYER_PRIVATE_KEY=0x${HEX32}`).includes('assigned-credential'));
    assert.ok(
      rules('DEMO_ACCESS_CODE: "' + 'correct-horse-battery' + '"').includes('assigned-credential'),
    );
  });

  it('flags key-named identifiers holding 32-byte hex', () => {
    assert.ok(rules(`const privateKey = '0x${HEX32}';`).includes('hex-key-literal'));
  });

  it('flags RPC URLs embedding provider keys', () => {
    const alchemy = 'https://eth-sepolia.g.alchemy.com/v2/' + 'AbCdEfGhIjKlMnOpQrSt';
    const infura = 'https://sepolia.infura.io/v3/' + 'f'.repeat(32);
    assert.ok(rules(alchemy).includes('rpc-url-with-key'));
    assert.ok(rules(infura).includes('rpc-url-with-key'));
  });

  it('flags sk-/mk- keys anywhere, but not short prefixes in prose', () => {
    const sk = 'sk-' + 'A1b2C3d4'.repeat(4);
    const mk = 'mk-' + 'z9_y8-x7'.repeat(4);
    assert.ok(rules(`Authorization: Bearer ${sk}`).includes('bearer-style-api-key'));
    assert.ok(rules(`const k = "${mk}"`).includes('bearer-style-api-key'));
    assert.ok(rules('ZG_MANAGEMENT_KEY=' + mk).includes('assigned-credential'));
    assert.deepEqual(rules('keys start with sk- (inference) or mk- (management)'), []);
    assert.deepEqual(rules('Authorization: Bearer sk-YOUR_API_KEY'), []);
    assert.deepEqual(rules('task-' + 'a'.repeat(30)), []);
  });

  it('flags JWTs (e.g. Privy access tokens)', () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = [
      part({ alg: 'ES256', typ: 'JWT' }),
      part({ iss: 'privy.io' }),
      'c2lnbmF0dXJl',
    ].join('.');
    assert.ok(rules(`Authorization: Bearer ${jwt}`).includes('jwt'));
    assert.deepEqual(rules('the token starts with eyJ but this is prose'), []);
  });

  it('flags PEM private key blocks', () => {
    assert.ok(rules('-----BEGIN ' + 'EC PRIVATE KEY-----').includes('pem-private-key'));
  });

  it('does not flag blank templates, placeholders, env indirections or tx hashes', () => {
    const clean = [
      'ZG_API_KEY=',
      'HEDERA_PAYER_PRIVATE_KEY=<your-key-here>',
      'const key = process.env.ZG_API_KEY;',
      'const id = import.meta.env.VITE_PRIVY_APP_ID;',
      'apiKey: ${ZG_API_KEY}',
      `Sepolia tx: 0x${HEX32}`,
      'Hedera tx: 0.0.1234@1730000000.123456789',
      "name: 'HEDERA_PAYER_PRIVATE_KEY',",
    ].join('\n');
    assert.deepEqual(scanText(clean), []);
  });

  it('honours the allow marker and never returns the full secret', () => {
    assert.deepEqual(scanText(`x=${DER_ECDSA} // ${ALLOW_MARKER}`), []);
    const [finding] = scanText(`x=${DER_ECDSA}`);
    assert.ok(finding !== undefined);
    assert.ok(!finding.preview.includes(HEX32));
    assert.equal(finding.line, 1);
  });

  it('detects binary content', () => {
    assert.equal(looksBinary(Buffer.from([0x50, 0x4b, 0x00, 0x01])), true);
    assert.equal(looksBinary(Buffer.from('plain text')), false);
  });
});
