import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  EnvFileError,
  EvidenceLeakError,
  argValue,
  evidenceJson,
  fileStamp,
  hasFlag,
  loadLocalEnvSource,
  redactUrls,
  writeEvidence,
} from '../lib/cli.ts';

describe('cli helpers', () => {
  it('reads flags and values', () => {
    const argv = ['node', 's.ts', '--', '--groups', 'a,b', '--confirm'];
    assert.equal(argValue('--groups', argv), 'a,b');
    assert.equal(argValue('--missing', argv), undefined);
    assert.equal(hasFlag('--confirm', argv), true);
  });

  it('formats file-name-safe UTC stamps', () => {
    assert.equal(fileStamp(new Date('2026-10-26T03:15:07.123Z')), '20261026T031507Z');
  });

  it('serialises bigint values as decimal strings', () => {
    assert.equal(JSON.parse(evidenceJson({ v: 12345678901234567890n })).v, '12345678901234567890');
  });
});

describe('writeEvidence', () => {
  it('writes public evidence under <root>/<track>/', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-'));
    try {
      const path = writeEvidence('hedera', 'accounts', { accountId: '0.0.5', balance: 10n }, root);
      assert.match(path, /hedera[\\/]accounts-\d{8}T\d{6}Z\.json$/);
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).balance, '10');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to write anything that looks like a key', () => {
    const root = mkdtempSync(join(tmpdir(), 'evidence-'));
    try {
      // Assembled at runtime so no key-shaped literal is committed.
      const der = ['3030020100300706052b81', '04000a04220420'].join('') + 'ab'.repeat(32);
      assert.throws(
        () => writeEvidence('hedera', 'oops', { privateKeyDer: der }, root),
        EvidenceLeakError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a .env with duplicate keys, without echoing values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envfile-'));
    try {
      const file = join(dir, '.env');
      writeFileSync(file, 'ZG_MODEL=\nZG_NETWORK=testnet\nZG_MODEL=secret-looking-value\n');
      assert.throws(
        () => loadLocalEnvSource(file),
        (e: unknown) =>
          e instanceof EnvFileError &&
          /line 3: duplicate key ZG_MODEL/.test(e.message) &&
          !e.message.includes('secret-looking-value'),
      );
      writeFileSync(file, 'ZG_MODEL=m\nZG_NETWORK=testnet\n');
      assert.equal(loadLocalEnvSource(file)['ZG_MODEL'], process.env['ZG_MODEL'] ?? 'm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts URL paths (RPC API keys) but keeps hosts', () => {
    const key = 'Ab' + 'Cd'.repeat(10);
    const msg = `HTTP request failed.\n\nURL: https://eth-sepolia.g.alchemy.com/v2/${key}\nRequest body: {}`;
    const out = redactUrls(msg);
    assert.ok(!out.includes(key));
    assert.match(out, /https:\/\/eth-sepolia\.g\.alchemy\.com\/…/);
    assert.equal(
      redactUrls('wss://sepolia.infura.io/ws/v3/abc?x=1 done'),
      'wss://sepolia.infura.io/… done',
    );
    assert.equal(redactUrls('no urls here'), 'no urls here');
  });
});
