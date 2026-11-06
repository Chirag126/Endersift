import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EnvValidationError,
  checkEnv,
  detectHederaKeyEncoding,
  ensEthName,
  expandGroups,
  hederaEntityId,
  integerInRange,
  labelledAccounts,
  loadEnv,
  origin,
  parseDotenv,
  parseLabelledAccounts,
  prefixedKey,
  url,
} from '../src/index.ts';

// Test-only key material is assembled at runtime so no key-shaped literal is
// ever committed (keeps gitleaks / GitHub push protection quiet on purpose).
const HEX32 = 'ab'.repeat(32);
const DER_ECDSA = ['3030020100300706052b81', '04000a04220420'].join('') + HEX32;
const DER_ED25519 = ['302e020100300506032b65', '7004220420'].join('') + HEX32;

const validHedera = {
  HEDERA_PAYER_ACCOUNT_ID: '0.0.1234',
  HEDERA_PAYER_PRIVATE_KEY: `0x${HEX32}`,
};

describe('validators', () => {
  it('accepts Hedera entity IDs and rejects aliases / EVM addresses', () => {
    assert.equal(hederaEntityId('0.0.1234'), null);
    assert.notEqual(hederaEntityId('0x' + '1'.repeat(40)), null);
    assert.notEqual(hederaEntityId('0.0.'), null);
    assert.notEqual(hederaEntityId('1.2.3'), null);
  });

  it('detects Hedera key encodings', () => {
    assert.equal(detectHederaKeyEncoding(HEX32), 'raw');
    assert.equal(detectHederaKeyEncoding(`0x${HEX32}`), 'raw');
    assert.equal(detectHederaKeyEncoding(DER_ECDSA), 'ecdsa');
    assert.equal(detectHederaKeyEncoding(DER_ED25519), 'ed25519');
    assert.equal(detectHederaKeyEncoding('not-hex'), null);
    assert.equal(detectHederaKeyEncoding('ab'.repeat(31)), null);
  });

  it('requires https except explicit localhost http', () => {
    assert.equal(url()('https://example.com'), null);
    assert.notEqual(url()('http://example.com'), null);
    assert.notEqual(url()('http://localhost:3001'), null);
    assert.equal(url({ allowLocalHttp: true })('http://localhost:3001'), null);
    assert.notEqual(url({ allowLocalHttp: true })('http://10.0.0.1'), null);
  });

  it('origin accepts scheme://host[:port] only', () => {
    assert.equal(origin('https://app.example'), null);
    assert.equal(origin('http://localhost:5173'), null);
    for (const bad of [
      'https://app.example/',
      'https://app.example/path',
      'https://app.example?x=1',
      'http://app.example',
      'https://user:pw@app.example',
      '*',
    ])
      assert.notEqual(origin(bad), null, bad);
    assert.notEqual(url()('https://user:pass@example.com'), null);
    assert.notEqual(url()('not a url'), null);
  });

  it('validates ENS parent names', () => {
    assert.equal(ensEthName('agents.eth'), null);
    assert.equal(ensEthName('intel.agents.eth'), null);
    assert.notEqual(ensEthName('Agents.eth'), null);
    assert.notEqual(ensEthName('agents.com'), null);
    assert.notEqual(ensEthName('a..eth'), null);
  });
});

describe('labelled provider accounts', () => {
  it('parses label:id pairs', () => {
    assert.deepEqual(parseLabelledAccounts('kev:0.0.11, cve:0.0.22'), [
      { label: 'kev', accountId: '0.0.11' },
      { label: 'cve', accountId: '0.0.22' },
    ]);
  });

  it('tolerates spaces around separators', () => {
    assert.deepEqual(parseLabelledAccounts(' kev : 0.0.11 ,cve:0.0.22 '), [
      { label: 'kev', accountId: '0.0.11' },
      { label: 'cve', accountId: '0.0.22' },
    ]);
  });

  it('explains a missing label without echoing the value', () => {
    const reason = parseLabelledAccounts('0.0.11044329');
    assert.equal(typeof reason, 'string');
    assert.match(String(reason), /needs a label/);
    assert.ok(!String(reason).includes('11044329'));
  });

  it('rejects malformed, duplicate or empty lists', () => {
    for (const bad of [
      'kev',
      'kev:0.0.1:x',
      'Kev:0.0.1',
      'k:0.0.1',
      'kev:1.2',
      'a1:0.0.1,a1:0.0.2',
      'aa:0.0.1,bb:0.0.1',
    ]) {
      assert.equal(typeof parseLabelledAccounts(bad), 'string', bad);
    }
    assert.notEqual(labelledAccounts(''), null);
    assert.equal(labelledAccounts('kev:0.0.1'), null);
  });
});

describe('group dependencies', () => {
  it('pulls hedera-network in for hedera, x402 and providers; ens in for ens-admin', () => {
    assert.deepEqual(expandGroups(['x402']), ['hedera-network', 'x402']);
    assert.deepEqual(expandGroups(['hedera']), ['hedera-network', 'hedera']);
    assert.deepEqual(expandGroups(['ens-admin']), ['ens', 'ens-admin']);
    assert.deepEqual(expandGroups(['core']), ['core']);
  });

  it('lets the facilitator probe load x402 without any secret', () => {
    const env = loadEnv(['x402'], {});
    assert.equal(env.require('HEDERA_NETWORK'), 'testnet');
    assert.equal(env.require('X402_FACILITATOR_URL'), 'https://api.testnet.blocky402.com');
    assert.throws(() => env.get('HEDERA_PAYER_PRIVATE_KEY'), /not loaded/);
  });
});

describe('checkEnv / loadEnv', () => {
  it('applies defaults and reports them as default, not ok', () => {
    const report = checkEnv(['core'], {});
    assert.equal(report.ok, true);
    const nodeEnv = report.vars.find((v) => v.name === 'NODE_ENV');
    assert.equal(nodeEnv?.status, 'default');
    const optional = report.vars.find((v) => v.name === 'DEMO_ACCESS_CODE');
    assert.equal(optional?.status, 'unset-optional');
  });

  it('loads only requested groups, so missing 0G config does not block Hedera', () => {
    const env = loadEnv(['hedera', 'x402'], validHedera);
    assert.equal(env.require('HEDERA_PAYER_ACCOUNT_ID'), '0.0.1234');
    assert.equal(env.get('X402_ASSET'), '0.0.0');
    assert.throws(() => env.get('ZG_API_KEY'), /group that was not loaded/);
  });

  it('collects every problem and never includes values in the message', () => {
    const secret = 'super-secret-value-123';
    try {
      loadEnv(['hedera', 'zg'], {
        HEDERA_PAYER_ACCOUNT_ID: 'alias-not-allowed',
        HEDERA_PAYER_PRIVATE_KEY: secret,
      });
      assert.fail('expected EnvValidationError');
    } catch (error) {
      assert.ok(error instanceof EnvValidationError);
      assert.match(error.message, /HEDERA_PAYER_ACCOUNT_ID/);
      assert.match(error.message, /HEDERA_PAYER_PRIVATE_KEY/);
      assert.match(error.message, /ZG_API_KEY is required/);
      assert.match(error.message, /ZG_MODEL is required/);
      assert.ok(!error.message.includes(secret), 'secret value leaked into error message');
      assert.ok(!error.message.includes('alias-not-allowed'), 'value leaked into error message');
    }
  });

  it('treats whitespace-only values as unset', () => {
    const report = checkEnv(['zg'], { ZG_API_KEY: '   ', ZG_MODEL: 'm' });
    assert.equal(report.vars.find((v) => v.name === 'ZG_API_KEY')?.status, 'missing');
  });

  it('rejects X402_NETWORK that does not match HEDERA_NETWORK', () => {
    const report = checkEnv(['hedera', 'x402'], {
      ...validHedera,
      HEDERA_NETWORK: 'testnet',
      X402_NETWORK: 'hedera:mainnet',
    });
    assert.equal(report.ok, false);
    assert.match(report.crossFieldErrors.join('\n'), /X402_NETWORK must match/);
  });

  it('rejects a mainnet mirror node on testnet', () => {
    const report = checkEnv(['hedera'], {
      ...validHedera,
      HEDERA_MIRROR_NODE_URL: 'https://mainnet.mirrornode.hedera.com',
    });
    assert.equal(report.ok, false);
  });

  it('rejects a DER key whose algorithm contradicts HEDERA_PAYER_KEY_TYPE', () => {
    const report = checkEnv(['hedera'], {
      ...validHedera,
      HEDERA_PAYER_PRIVATE_KEY: DER_ED25519,
      HEDERA_PAYER_KEY_TYPE: 'ecdsa',
    });
    assert.equal(report.ok, false);
    assert.match(report.crossFieldErrors.join('\n'), /DER-encoded ed25519/);
    assert.equal(
      checkEnv(['hedera'], { ...validHedera, HEDERA_PAYER_PRIVATE_KEY: DER_ECDSA }).ok,
      true,
    );
  });

  it('rejects a provider list that contains the payer (no self-payment)', () => {
    const report = checkEnv(['hedera', 'hedera-providers'], {
      ...validHedera,
      HEDERA_PROVIDER_ACCOUNTS: 'kev:0.0.1234,cve:0.0.99',
    });
    assert.equal(report.ok, false);
    assert.match(report.crossFieldErrors.join('\n'), /no self-payment/);
    assert.equal(
      checkEnv(['hedera', 'hedera-providers'], {
        ...validHedera,
        HEDERA_PROVIDER_ACCOUNTS: 'kev:0.0.7',
      }).ok,
      true,
    );
  });

  it('does not require the ENS admin key when only the ens read group is loaded', () => {
    const report = checkEnv(['ens'], {
      ETH_RPC_URL: 'https://rpc.example.com',
      ENS_PARENT_NAME: 'agents.eth',
    });
    assert.equal(report.ok, true);
    assert.ok(!report.vars.some((v) => v.name === 'ENS_ADMIN_PRIVATE_KEY'));
  });
});

describe('0G env', () => {
  // Shapes only; assembled at runtime so no key-shaped literal is committed.
  const SK = 'sk-' + 'x'.repeat(30);
  const MK = 'mk-' + 'y'.repeat(30);
  const TESTNET_URL = 'https://router-api-testnet.integratenetwork.work/v1';

  it('validates key prefixes without echoing values', () => {
    const sk = prefixedKey('sk-', '0G Router API key');
    assert.equal(sk(SK), null);
    const wrong = sk(MK);
    assert.match(wrong ?? '', /starting with sk-/);
    assert.ok(!(wrong ?? '').includes(MK));
    assert.match(sk('sk-short') ?? '', /too short/);
    assert.match(sk('sk-' + 'a b'.repeat(5)) ?? '', /whitespace/);
  });

  it('validates integer ranges', () => {
    const r = integerInRange(1, 8192);
    assert.equal(r('256'), null);
    assert.notEqual(r('0'), null);
    assert.notEqual(r('8193'), null);
    assert.notEqual(r('1.5'), null);
  });

  it('reads the catalog group with no credentials at all', () => {
    const env = loadEnv(['zg-network'], {});
    assert.equal(env.require('ZG_NETWORK'), 'mainnet');
    assert.equal(env.require('ZG_ROUTER_BASE_URL'), 'https://router-api.0g.ai/v1');
    assert.throws(() => env.get('ZG_API_KEY'), /group that was not loaded/);
  });

  it('loads zg with defaults; the management key is optional', () => {
    const env = loadEnv(['zg'], { ZG_API_KEY: SK, ZG_MODEL: 'some-model' });
    assert.ok(env.groups.includes('zg-network'));
    assert.equal(env.get('ZG_MANAGEMENT_KEY'), undefined);
    assert.equal(env.require('ZG_OUTPUT_LIMIT'), '256');
    assert.equal(env.require('ZG_MAX_CALL_COST_NEURON'), '1000000000000000');
    assert.equal(env.require('ZG_DAILY_CAP_NEURON'), '10000000000000000');
    assert.equal(env.require('ZG_SNAPSHOT_INTERVAL_MIN'), '60');
  });

  it('orders the x402 firewall budgets: per payment <= per run <= per day', () => {
    const run = checkEnv(['x402'], { X402_MAX_PAYMENT_TINYBARS: '5000000' });
    assert.match(
      run.crossFieldErrors.join(),
      /X402_RUN_BUDGET_TINYBARS must be >= X402_MAX_PAYMENT/,
    );
    const day = checkEnv(['x402'], { X402_DAILY_BUDGET_TINYBARS: '2000000' });
    assert.match(day.crossFieldErrors.join(), /X402_DAILY_BUDGET_TINYBARS must be >= X402_RUN/);
    assert.equal(checkEnv(['x402'], {}).ok, true, 'defaults are consistent');
  });

  it('refuses a daily inference cap below the per-call cap', () => {
    const base = { ZG_API_KEY: SK, ZG_MODEL: 'm', ZG_MAX_CALL_COST_NEURON: '5000000000000000' };
    const low = checkEnv(['zg'], { ...base, ZG_DAILY_CAP_NEURON: '4999999999999999' });
    assert.match(
      low.crossFieldErrors.join(),
      /ZG_DAILY_CAP_NEURON must be >= ZG_MAX_CALL_COST_NEURON/,
    );
    assert.equal(checkEnv(['zg'], { ...base, ZG_DAILY_CAP_NEURON: '5000000000000000' }).ok, true);
    const fast = checkEnv(['zg'], { ...base, ZG_SNAPSHOT_INTERVAL_MIN: '1' });
    assert.equal(fast.vars.find((v) => v.name === 'ZG_SNAPSHOT_INTERVAL_MIN')?.status, 'invalid');
  });

  it('rejects an mk- key in ZG_API_KEY and an sk- key in ZG_MANAGEMENT_KEY', () => {
    const report = checkEnv(['zg'], { ZG_API_KEY: MK, ZG_MANAGEMENT_KEY: SK, ZG_MODEL: 'm' });
    assert.equal(report.vars.find((v) => v.name === 'ZG_API_KEY')?.status, 'invalid');
    assert.equal(report.vars.find((v) => v.name === 'ZG_MANAGEMENT_KEY')?.status, 'invalid');
  });

  it('rejects a Router URL that belongs to the other network', () => {
    const mismatch = checkEnv(['zg-network'], { ZG_NETWORK: 'testnet' });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.crossFieldErrors.join(), /mainnet Router but ZG_NETWORK is testnet/);
    const reverse = checkEnv(['zg-network'], { ZG_ROUTER_BASE_URL: TESTNET_URL });
    assert.match(reverse.crossFieldErrors.join(), /testnet Router but ZG_NETWORK is mainnet/);
    const ok = checkEnv(['zg-network'], { ZG_NETWORK: 'testnet', ZG_ROUTER_BASE_URL: TESTNET_URL });
    assert.equal(ok.ok, true);
  });
});

describe('parseDotenv', () => {
  it('parses quotes, export prefix, comments and CRLF', () => {
    const text = [
      '# comment',
      'export A=1',
      'B="two words" # comment',
      "C='x#y'",
      'D=plain # trailing',
      'E=',
      '',
    ].join('\r\n');
    const { entries, errors } = parseDotenv(text);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      entries.map((e) => [e.key, e.value]),
      [
        ['A', '1'],
        ['B', 'two words'],
        ['C', 'x#y'],
        ['D', 'plain'],
        ['E', ''],
      ],
    );
  });

  it('strips a UTF-8 byte-order mark (files saved by Windows editors)', () => {
    const { entries, errors } = parseDotenv('﻿A=1\n');
    assert.deepEqual(errors, []);
    assert.equal(entries[0]?.key, 'A');
  });

  it('reports duplicates, bad keys and unterminated quotes', () => {
    const { errors } = parseDotenv('A=1\nA=2\nlower=x\nB="open\nnot-an-assignment');
    assert.equal(errors.length, 4);
  });
});
