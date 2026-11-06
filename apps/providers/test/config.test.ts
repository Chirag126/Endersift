// Class: unit (offline). Provider config is built from secret-free env groups.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnvValidationError } from '@agent-economy/core';
import { loadIntelConfig, loadProviderConfig } from '../src/config.ts';

const BASE = { HEDERA_PROVIDER_ACCOUNTS: 'kev:0.0.11044329,cve:0.0.22' };

describe('loadProviderConfig', () => {
  it('uses defaults and the first provider when no label is given', () => {
    const c = loadProviderConfig(BASE);
    assert.equal(c.label, 'kev');
    assert.equal(c.payTo, '0.0.11044329');
    assert.equal(c.port, 4021);
    assert.equal(c.priceTinybars, 100_000n);
    assert.equal(c.network, 'hedera:testnet');
    assert.equal(c.facilitatorUrl, 'https://api.testnet.blocky402.com');
  });

  it('selects a provider by label and rejects unknown labels', () => {
    assert.equal(loadProviderConfig(BASE, 'cve').payTo, '0.0.22');
    assert.throws(() => loadProviderConfig(BASE, 'osv'), /not configured/);
  });

  it('never requires the payer private key', () => {
    // No HEDERA_PAYER_* variables at all: must still load.
    assert.doesNotThrow(() => loadProviderConfig(BASE));
  });

  it('rejects an invalid price', () => {
    assert.throws(
      () => loadProviderConfig({ ...BASE, X402_DEMO_PRICE_TINYBARS: '0' }),
      EnvValidationError,
    );
  });
});

describe('loadIntelConfig', () => {
  const ALL = { HEDERA_PROVIDER_ACCOUNTS: 'kev:0.0.11044329,cve:0.0.11183141,osv:0.0.11183142' };

  it('serves every manifest agent at its ENS price, with facilitators and public URL from env', () => {
    const c = loadIntelConfig(ALL);
    assert.deepEqual(
      c.providers.map((p) => `${p.label}:${p.priceAtomic}:${p.payTo}`),
      ['kev:100000:0.0.11044329', 'cve:150000:0.0.11183141', 'osv:120000:0.0.11183142'],
    );
    assert.equal(c.facilitatorUrl, 'https://api.testnet.blocky402.com');
    assert.equal(c.fallbackFacilitatorUrl, 'https://x402.org/facilitator');
    assert.equal(c.publicUrl, 'http://127.0.0.1:4021', 'defaults to the local port');
    assert.equal(c.asset, '0.0.0');
    assert.equal(c.production, false);
  });

  it('takes PROVIDERS_PUBLIC_URL and PROVIDERS_PORT into account', () => {
    assert.equal(
      loadIntelConfig({ ...ALL, PROVIDERS_PORT: '5000' }).publicUrl,
      'http://127.0.0.1:5000',
    );
    assert.equal(
      loadIntelConfig({ ...ALL, PROVIDERS_PUBLIC_URL: 'https://api.example.onrender.com/' })
        .publicUrl,
      'https://api.example.onrender.com',
    );
    assert.throws(
      () => loadIntelConfig({ ...ALL, PROVIDERS_PUBLIC_URL: 'http://public.example' }),
      EnvValidationError,
    );
  });

  it('applies the default fallback when the variable is empty, and knows production', () => {
    // The env loader treats empty values as unset (packages/core), so the default applies.
    assert.equal(
      loadIntelConfig({ ...ALL, X402_FALLBACK_FACILITATOR_URL: '' }).fallbackFacilitatorUrl,
      'https://x402.org/facilitator',
    );
    const deployed = {
      ...ALL,
      NODE_ENV: 'production',
      PROVIDERS_PUBLIC_URL: 'https://providers.example',
    };
    assert.equal(loadIntelConfig(deployed).production, true);
  });

  it("the USDC lane is off by default, and uses the network's Circle USDC when priced (D-064)", () => {
    assert.equal(loadIntelConfig(ALL).usdcPing, null);
    assert.deepEqual(loadIntelConfig({ ...ALL, X402_USDC_PING_ATOMIC: '10000' }).usdcPing, {
      tokenId: '0.0.429274',
      priceAtomic: 10_000n,
    });
    assert.throws(
      () => loadIntelConfig({ ...ALL, X402_USDC_PING_ATOMIC: '0' }),
      /X402_USDC_PING_ATOMIC/,
    );
  });

  it('in production the public URL must be https (D-062)', () => {
    assert.throws(
      () => loadIntelConfig({ ...ALL, NODE_ENV: 'production' }),
      /PROVIDERS_PUBLIC_URL must be the https URL/,
    );
    assert.equal(
      loadIntelConfig({
        ...ALL,
        NODE_ENV: 'production',
        PROVIDERS_PUBLIC_URL: 'https://p.example/',
      }).publicUrl,
      'https://p.example',
    );
  });

  it('refuses a non-HBAR asset and a missing payout account', () => {
    assert.throws(() => loadIntelConfig({ ...ALL, X402_ASSET: '0.0.456858' }), /charge HBAR/);
    assert.throws(() => loadIntelConfig(BASE), /no payout account for: osv/);
  });
});
