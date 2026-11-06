// Class: unit. ENSv2 subname setups (D-066): the role bitmaps match the
// deployed RegistryRolesLib, the labels and the trial expiry are bounded, and
// the record file is read and written stably. No network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROLE_CAN_TRANSFER_ADMIN, SUBNAME_TOKEN_ROLES } from '../src/constants.ts';
import {
  LOCKED_ROLES,
  TRANSFERABLE_ROLES,
  parseSetups,
  serializeSetups,
  setupLabels,
  trialExpiry,
  type EnsSetupsRecord,
} from '../src/setups.ts';

const RECORD: EnsSetupsRecord = {
  kind: 'ens-setups',
  version: 1,
  parent: 'chirag126.eth',
  subregistry: '0x3F54Fcd9ea71D96db6e66aaecCB5B20c3C003758',
  parentResolver: '0x10698316B4C5e0d714CCC50cBAB6B9de80843F7c',
  setups: [
    { kind: 'wildcard', name: 'unlisted-x.chirag126.eth', expiry: null, owner: null, proof: 'p' },
    {
      kind: 'expiring',
      name: 'trial-x.chirag126.eth',
      expiry: '1793300000',
      owner: '0x66359fa8d11365B71bCB9e7324Bf73c5487a77F5',
      proof: 'p',
    },
  ],
};

describe('ENSv2 subname setups (D-066)', () => {
  it('transferable = the registrar token roles; locked = the same without the transfer right', () => {
    assert.equal(TRANSFERABLE_ROLES, SUBNAME_TOKEN_ROLES);
    assert.equal(TRANSFERABLE_ROLES & ROLE_CAN_TRANSFER_ADMIN, ROLE_CAN_TRANSFER_ADMIN);
    assert.equal(LOCKED_ROLES & ROLE_CAN_TRANSFER_ADMIN, 0n);
    assert.equal(LOCKED_ROLES | ROLE_CAN_TRANSFER_ADMIN, TRANSFERABLE_ROLES);
  });

  it('labels are DNS-style and new for every run', () => {
    const l = setupLabels('20261029T010203Z');
    assert.deepEqual(Object.values(l), [
      'trial-20261029t010203z',
      'movable-20261029t010203z',
      'locked-20261029t010203z',
      'unlisted-20261029t010203z',
      'directory-20261029t010203z',
    ]);
    for (const label of Object.values(l)) assert.match(label, /^[a-z0-9-]{3,63}$/);
  });

  it('the trial lasts 10 minutes to 7 days', () => {
    assert.equal(trialExpiry(1_000n, 30), 2_800n);
    assert.throws(() => trialExpiry(0n, 5), /10 minutes/);
    assert.throws(() => trialExpiry(0n, 7 * 24 * 60 + 1), /7 days/);
  });

  it('the record is read defensively and written in a stable order', () => {
    const text = serializeSetups(RECORD);
    assert.equal(text, serializeSetups({ ...RECORD, setups: [...RECORD.setups].reverse() }));
    const parsed = parseSetups(JSON.parse(text));
    assert.equal(parsed?.setups[0]?.kind, 'expiring', 'kind order');
    for (const bad of [
      { ...RECORD, kind: 'other' },
      { ...RECORD, parentResolver: 'nope' },
      { ...RECORD, setups: [{ ...RECORD.setups[0], name: 'trial.other.eth' }] },
      { ...RECORD, setups: [{ ...RECORD.setups[0], kind: 'forever' }] },
    ])
      assert.equal(parseSetups(bad), null);
  });
});
