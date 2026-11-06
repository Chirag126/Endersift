import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  REGISTRY_ROLES,
  ROLE_CAN_TRANSFER_ADMIN,
  SUBNAME_TOKEN_ROLES,
  USER_REGISTRY_ROOT_ROLES,
} from '../src/constants.ts';
import { loadSubname, newSubname, parseSubname, saveSubname } from '../src/subname-state.ts';

const OWNER = '0x' + 'ab'.repeat(20);
const EXPECTED = { chainId: 11155111, parent: 'chirag126.eth', label: 'kev', owner: OWNER };

describe('subname state', () => {
  it('round-trips and refuses mismatched files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subname-'));
    try {
      const path = join(dir, 's.json');
      assert.equal(loadSubname(path, EXPECTED), null);
      const s = { ...newSubname(EXPECTED), registry: '0x' + '11'.repeat(20) };
      saveSubname(path, s);
      assert.deepEqual(loadSubname(path, EXPECTED), s);
      const text = JSON.stringify(s);
      assert.throws(() => parseSubname(text, { ...EXPECTED, label: 'cve' }), /another name/);
      assert.throws(() => parseSubname(text, { ...EXPECTED, chainId: 1 }), /another chain/);
      assert.throws(
        () => parseSubname(JSON.stringify({ ...s, registry: 'nope' }), EXPECTED),
        /malformed/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('registry role bitmaps', () => {
  it('gives the subregistry owner every grantable root role with its admin', () => {
    for (const role of Object.values(REGISTRY_ROLES)) {
      assert.equal(USER_REGISTRY_ROOT_ROLES & role, role);
      assert.equal(USER_REGISTRY_ROOT_ROLES & (role << 128n), role << 128n);
    }
    assert.equal(USER_REGISTRY_ROOT_ROLES & ROLE_CAN_TRANSFER_ADMIN, ROLE_CAN_TRANSFER_ADMIN);
    // ROLE_WAS_RESERVED (1 << 32) is token-only and must never be granted at root.
    assert.equal(USER_REGISTRY_ROOT_ROLES & (1n << 32n), 0n);
  });

  it('mirrors the ETHRegistrar registrant bitmap for subname owners', () => {
    const expected =
      REGISTRY_ROLES.SET_SUBREGISTRY |
      (REGISTRY_ROLES.SET_SUBREGISTRY << 128n) |
      REGISTRY_ROLES.SET_RESOLVER |
      (REGISTRY_ROLES.SET_RESOLVER << 128n) |
      ROLE_CAN_TRANSFER_ADMIN;
    assert.equal(SUBNAME_TOKEN_ROLES, expected);
  });
});
