// Class: unit. The startup comparison between this service and live ENS records.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiscoverySnapshot } from '@agent-economy/ens';
import { EnsMismatchError, compareWithEns } from '../src/ens-check.ts';
import { SERVED, ensProvider } from './ens-fixtures.ts';

type Provider = DiscoverySnapshot['providers'][number];

const compare = (
  providers: Provider[],
  skipped: DiscoverySnapshot['skipped'] = [],
  publicUrl = 'http://127.0.0.1:4021',
) =>
  compareWithEns({
    served: SERVED,
    network: 'hedera:testnet',
    asset: '0.0.0',
    publicUrl,
    snapshot: { providers, skipped },
  });

describe('compareWithEns (startup check)', () => {
  it('accepts a service that matches ENS exactly', () => {
    assert.deepEqual(compare([ensProvider('kev'), ensProvider('cve')]), []);
    assert.deepEqual(
      compare([ensProvider('kev'), ensProvider('cve')], [], 'http://127.0.0.1:4021/'),
      [],
      'trailing slash',
    );
  });

  it('flags a price or payTo that differs from ENS', () => {
    const m = compare([
      ensProvider('kev', { priceAtomic: '200000' }),
      ensProvider('cve', { payTo: '0.0.999' }),
    ]);
    assert.deepEqual(m, [
      { label: 'kev', field: 'agent.price', service: '100000', ens: '200000' },
      { label: 'cve', field: 'x402.payTo', service: '0.0.11183141', ens: '0.0.999' },
    ]);
  });

  it('flags network, asset and endpoint differences', () => {
    const m = compare([
      ensProvider('kev', { network: 'hedera:mainnet' }),
      ensProvider('cve', { asset: '0.0.456858', endpoint: 'https://elsewhere.example/v1/cve' }),
    ]);
    assert.deepEqual(
      m.map((x) => `${x.label}:${x.field}`),
      ['kev:x402.network', 'cve:x402.asset', 'cve:agent.endpoint'],
    );
    // the deployed URL must match too
    const deployed = compare(
      [ensProvider('kev'), ensProvider('cve')],
      [],
      'https://api.example.onrender.com',
    );
    assert.equal(deployed.filter((x) => x.field === 'agent.endpoint').length, 2);
  });

  it('flags a served agent that is not purchasable in ENS, with the discovery reason', () => {
    const m = compare(
      [ensProvider('kev')],
      [
        {
          label: 'cve',
          code: 'NOT_PURCHASABLE',
          reason: 'agent.status is paused, not active',
          registeredAtBlock: 1n,
        },
      ],
    );
    assert.deepEqual(m, [
      {
        label: 'cve',
        field: 'missing',
        service: 'served',
        ens: 'NOT_PURCHASABLE: agent.status is paused, not active',
      },
    ]);
    assert.equal(compare([ensProvider('kev')])[0]?.ens, 'not registered in the subregistry');
  });

  it('explains every mismatch and how to fix it', () => {
    const err = new EnsMismatchError(
      compare([ensProvider('kev', { priceAtomic: '1' }), ensProvider('cve', { payTo: '0.0.2' })]),
    );
    assert.match(err.message, /refusing to start: 2 difference/);
    assert.match(err.message, /kev: agent\.price is 100000 here but 1 in ENS/);
    assert.match(err.message, /cve: x402\.payTo is 0\.0\.11183141 here but 0\.0\.2 in ENS/);
    assert.match(err.message, /ens:provision/);
    assert.equal(err.mismatches.length, 2);
  });
});
