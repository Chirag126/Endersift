import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  RegistrationStateError,
  loadRegistration,
  newRegistration,
  parseRegistration,
  saveRegistration,
} from '../src/state.ts';

const OWNER = '0x' + 'aB'.repeat(20);
const BASE = {
  chainId: 11155111,
  name: 'myagents.eth',
  label: 'myagents',
  owner: OWNER,
  secret: '0x' + '0f'.repeat(32),
};
const EXPECTED = { chainId: 11155111, name: 'myagents.eth', owner: OWNER.toLowerCase() };

describe('registration state', () => {
  it('round-trips through an atomic, owner-only file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ensstate-'));
    try {
      const path = join(dir, 'nested', 'state.json');
      assert.equal(loadRegistration(path, EXPECTED), null);
      const s = { ...newRegistration(BASE), resolver: '0x' + '22'.repeat(20) };
      saveRegistration(path, s);
      assert.deepEqual(loadRegistration(path, EXPECTED), s);
      if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.ok(readFileSync(path, 'utf8').endsWith('\n'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses files for another chain, name or owner, and malformed secrets', () => {
    const text = JSON.stringify(newRegistration(BASE));
    assert.throws(() => parseRegistration(text, { ...EXPECTED, chainId: 1 }), /another chain/);
    assert.throws(
      () => parseRegistration(text, { ...EXPECTED, name: 'other.eth' }),
      /another name/,
    );
    assert.throws(
      () => parseRegistration(text, { ...EXPECTED, owner: '0x' + '00'.repeat(20) }),
      /another owner/,
    );
    const bad = JSON.stringify({ ...newRegistration(BASE), secret: '0x1234' });
    assert.throws(() => parseRegistration(bad, EXPECTED), RegistrationStateError);
    assert.throws(() => parseRegistration('{', EXPECTED), /not valid JSON/);
    assert.throws(() => newRegistration({ ...BASE, secret: 'nope' }), /32 bytes/);
  });
});
