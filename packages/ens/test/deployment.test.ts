import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DeploymentFileError,
  parseDeployment,
  publishedRecords,
  sameDeployment,
  serializeDeployment,
  type Deployment,
} from '../src/deployment.ts';
import {
  OperatorKeyFileError,
  loadOperatorKeyFile,
  operatorAddresses,
  parseOperatorKeyFile,
  saveOperatorKeyFile,
  type OperatorKeyFile,
} from '../src/operators.ts';

const ADMIN = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const deployment = (patch: Partial<Deployment> = {}): Deployment => ({
  kind: 'ens-deployment',
  version: 1,
  chain: 'sepolia',
  chainId: 11155111,
  parent: 'chirag126.eth',
  admin: ADMIN,
  contracts: { ethRegistry: '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4' },
  subregistry: '0x3F54Fcd9ea71D96db6e66aaecCB5B20c3C003758',
  agents: [
    {
      label: 'kev',
      name: 'kev.chirag126.eth',
      resolver: '0x1993BB58708a630AF1CC01304Dd851BDEccF9261',
      expiry: '1824000000',
      operator: '0x2222222222222222222222222222222222222222',
      operatorKeys: ['agent.endpoint'],
      adminKeys: ['x402.payTo'],
      records: { 'agent.endpoint': 'http://127.0.0.1:4021/v1/kev' },
    },
  ],
  ...patch,
});

describe('deployment file', () => {
  it('serialises deterministically, so a converged rerun changes no bytes', () => {
    assert.equal(serializeDeployment(deployment()), serializeDeployment(deployment()));
    assert.ok(serializeDeployment(deployment()).endsWith('}\n'));
    assert.ok(!/T\d\d:\d\d/.test(serializeDeployment(deployment())), 'no timestamps');
  });

  it('compares addresses case-insensitively and everything else exactly', () => {
    const lower = deployment({ subregistry: '0x3f54fcd9ea71d96db6e66aaeccb5b20c3c003758' });
    assert.ok(sameDeployment(deployment(), lower));
    const changed = deployment({
      agents: [
        { ...deployment().agents[0]!, records: { 'agent.endpoint': 'https://x.example/v1/kev' } },
      ],
    });
    assert.ok(!sameDeployment(deployment(), changed));
  });

  it('round-trips through the parser and refuses malformed files', () => {
    assert.ok(sameDeployment(parseDeployment(serializeDeployment(deployment())), deployment()));
    assert.throws(() => parseDeployment('{'), DeploymentFileError);
    assert.throws(
      () => parseDeployment('{"kind":"other","version":1,"agents":[]}'),
      DeploymentFileError,
    );
    const bad = JSON.stringify({
      ...deployment(),
      agents: [{ label: 'kev', operator: 'nope', resolver: '0x1' }],
    });
    assert.throws(() => parseDeployment(bad), DeploymentFileError);
  });

  it('publishes records in spec order and drops empty values', () => {
    assert.deepEqual(publishedRecords(['b', 'a', 'c'], { a: '1', b: '2', c: '' }), {
      b: '2',
      a: '1',
    });
    assert.deepEqual(Object.keys(publishedRecords(['b', 'a'], { a: '1', b: '2' })), ['b', 'a']);
  });
});

describe('operator key file', () => {
  const expected = { chainId: 11155111, parent: 'chirag126.eth', admin: ADMIN };
  const file: OperatorKeyFile = {
    version: 1,
    ...expected,
    operators: {
      kev: {
        address: '0x2222222222222222222222222222222222222222',
        privateKey: `0x${'a'.repeat(64)}`,
      },
      cve: {
        address: '0x3333333333333333333333333333333333333333',
        privateKey: `0x${'b'.repeat(64)}`,
      },
    },
  };

  it('round-trips through an owner-only file and exposes addresses only', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ops-')), 'ens-operator-keys.json');
    saveOperatorKeyFile(path, file);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(loadOperatorKeyFile(path, expected), file);
    const addresses = operatorAddresses(file);
    assert.equal(addresses.get('kev'), '0x2222222222222222222222222222222222222222');
    assert.ok(![...addresses.values()].some((v) => v.length > 42));
    assert.ok(readFileSync(path, 'utf8').includes('"privateKey"'));
    assert.equal(loadOperatorKeyFile(join(path, '..', 'missing.json'), expected), null);
  });

  it('refuses files for another chain, parent or admin, and unsafe operators', () => {
    const text = (f: unknown) => JSON.stringify(f);
    assert.throws(
      () => parseOperatorKeyFile(text({ ...file, chainId: 1 }), expected),
      OperatorKeyFileError,
    );
    assert.throws(
      () => parseOperatorKeyFile(text({ ...file, parent: 'x.eth' }), expected),
      OperatorKeyFileError,
    );
    assert.throws(
      () => parseOperatorKeyFile(text({ ...file, admin: '0x' + '1'.repeat(40) }), expected),
      OperatorKeyFileError,
    );
    const adminAsOperator = {
      ...file,
      operators: { kev: { address: ADMIN, privateKey: `0x${'a'.repeat(64)}` } },
    };
    assert.throws(
      () => parseOperatorKeyFile(text(adminAsOperator), expected),
      /must not be the admin/,
    );
    const shared = {
      ...file,
      operators: {
        kev: file.operators.kev,
        cve: { ...file.operators.cve!, address: file.operators.kev!.address },
      },
    };
    assert.throws(() => parseOperatorKeyFile(text(shared), expected), /share one operator/);
    const badKey = {
      ...file,
      operators: { kev: { address: file.operators.kev!.address, privateKey: '0x12' } },
    };
    assert.throws(() => parseOperatorKeyFile(text(badKey), expected), /malformed key/);
  });
});
