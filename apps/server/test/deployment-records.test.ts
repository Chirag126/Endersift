// Class: unit. The committed Sepolia records shown on the Providers page
// (D-066): absent or malformed files read as null, valid ones are parsed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { readDeploymentRecords } from '../src/deployment-records.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function root(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'deploy-records-'));
  dirs.push(d);
  mkdirSync(join(d, 'deployments'));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(d, 'deployments', name), text);
  return d;
}

describe('deployment records (D-066)', () => {
  it('absent files are null, not an error', () => {
    assert.deepEqual(readDeploymentRecords(root({})), { erc8004: null, setups: null });
  });

  it('malformed files are null', () => {
    const r = readDeploymentRecords(
      root({ 'sepolia-erc8004.json': '{not json', 'sepolia-setups.json': '{"kind":"other"}' }),
    );
    assert.deepEqual(r, { erc8004: null, setups: null });
  });

  it('valid files are parsed', () => {
    const r = readDeploymentRecords(
      root({
        'sepolia-erc8004.json': JSON.stringify({
          kind: 'erc8004-deployment',
          version: 1,
          chainId: 11155111,
          identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
          agents: {
            kev: {
              agentId: '42',
              agentURI: 'https://example.org/.well-known/erc-8004/kev.json',
              owner: '0x66359fa8d11365B71bCB9e7324Bf73c5487a77F5',
            },
          },
        }),
      }),
    );
    assert.equal(r.erc8004?.agents['kev']?.agentId, '42');
    assert.equal(r.setups, null);
  });

  it("the committed Sepolia records parse and match the owner's verified runs", () => {
    const r = readDeploymentRecords('.');
    assert.deepEqual(
      Object.entries(r.erc8004?.agents ?? {}).map(([label, a]) => `${label}:${a.agentId}`),
      ['agent:11233', 'cve:11231', 'kev:11230', 'osv:11232'],
    );
    assert.deepEqual(
      r.setups?.setups.map((x) => x.kind),
      ['expiring', 'transferable', 'locked', 'wildcard', 'alias'],
    );
  });
});
