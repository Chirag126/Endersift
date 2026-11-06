// Class: mock. Provider startup with FAKE facilitators and a FAKE ENS
// discovery snapshot: the config test of plan row 16 (a mismatch with ENS
// fails startup) plus facilitator fallback and the production guard.
// CI only (needs the @x402 packages).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiscoverySnapshot } from '@agent-economy/ens';
import type { FacilitatorEntry } from '@agent-economy/hedera/x402-server';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { FacilitatorClient } from '@x402/core/server';
import type { IntelServiceConfig } from '../src/config.ts';
import { EnsMismatchError } from '../src/ens-check.ts';
import { KevFeed } from '../src/feeds/kev.ts';
import { NvdClient } from '../src/feeds/nvd.ts';
import { OsvClient } from '../src/feeds/osv.ts';
import { ProviderStartupError, prepareProviderService } from '../src/startup.ts';
import { SERVED, ensProvider } from './ens-fixtures.ts';

const CONFIG: IntelServiceConfig = {
  network: 'hedera:testnet',
  facilitatorUrl: 'https://primary.example',
  fallbackFacilitatorUrl: 'https://fallback.example',
  asset: '0.0.0',
  port: 4021,
  publicUrl: 'http://127.0.0.1:4021',
  production: false,
  usdcPing: null,
  agentUrl: null,
  briefSale: null,
  pingPriceTinybars: 100_000n,
  providers: SERVED,
  nvdApiKey: undefined,
};

function facilitator(feePayer: string, up = true): FacilitatorClient {
  return {
    async getSupported() {
      if (!up) throw new Error('connect ECONNREFUSED');
      return {
        kinds: [
          { x402Version: 2, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer } },
        ],
        extensions: [],
        signers: { 'hedera:*': [feePayer] },
      };
    },
    async verify() {
      return { isValid: true, payer: '0.0.1001' };
    },
    async settle() {
      return {
        success: true,
        transaction: '0.0.1@1.1',
        network: 'hedera:testnet',
        payer: '0.0.1001',
      };
    },
  };
}

const entries = (primaryUp = true, fallbackUp = true): FacilitatorEntry[] => [
  {
    role: 'primary',
    url: 'https://primary.example',
    client: facilitator('0.0.7162784', primaryUp),
  },
  {
    role: 'fallback',
    url: 'https://fallback.example',
    client: facilitator('0.0.9185802', fallbackUp),
  },
];

const snapshot = (providers = [ensProvider('kev'), ensProvider('cve')]): DiscoverySnapshot => ({
  parent: 'chirag126.eth',
  subregistry: '0x3F54Fcd9ea71D96db6e66aaecCB5B20c3C003758',
  blockNumber: 12_000_600n,
  blockHash: `0x${'cd'.repeat(32)}`,
  blockTimestamp: 1_793_000_000n,
  fromBlock: 11_999_808n,
  logsScanned: 2,
  labelsSeen: 2,
  allowLocalHttp: true,
  providers,
  skipped: [],
});

const feeds = () => ({ kev: new KevFeed(), nvd: new NvdClient(), osv: new OsvClient() });

describe('provider startup', () => {
  it('starts when every served agent matches its ENS records, binding the primary facilitator', async () => {
    const { service, report } = await prepareProviderService({
      config: CONFIG,
      facilitators: entries(),
      discover: async () => snapshot(),
      feeds: feeds(),
    });
    assert.equal(report.bound.role, 'primary');
    assert.equal(report.ens.checked, true);
    // the 402 quote names the bound facilitator's fee payer and the ENS price/payTo
    const res = await service.app.fetch(
      new Request('http://127.0.0.1:4021/v1/kev/recent?since=2026-10-01'),
    );
    assert.equal(res.status, 402);
    const body: unknown = await res.json().catch(() => undefined);
    const req = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
      (n) => res.headers.get(n),
      body,
    ).accepts[0];
    assert.equal(req?.amount, '100000');
    assert.equal(req?.payTo, '0.0.11044329');
    assert.equal(req?.extra['feePayer'], '0.0.7162784');
  });

  it('reads ENS again when a read fails (RPC 429 on a cold start), and stops after the last try (D-082)', async () => {
    let reads = 0;
    const { report } = await prepareProviderService({
      config: CONFIG,
      facilitators: entries(),
      discover: async () => {
        reads += 1;
        if (reads < 3) throw new Error('HTTP request failed.\nStatus: 429');
        return snapshot();
      },
      feeds: feeds(),
      ensRetryDelaysMs: [0, 0],
    });
    assert.equal(reads, 3);
    assert.equal(report.ens.checked, true);

    reads = 0;
    await assert.rejects(
      prepareProviderService({
        config: CONFIG,
        facilitators: entries(),
        discover: async () => {
          reads += 1;
          throw new Error('HTTP request failed.\nStatus: 429');
        },
        feeds: feeds(),
        ensRetryDelaysMs: [0, 0],
      }),
      /Status: 429/,
    );
    assert.equal(reads, 3);
  });

  it('does not read ENS again when the records disagree (a mismatch is not a failed read)', async () => {
    let reads = 0;
    await assert.rejects(
      prepareProviderService({
        config: CONFIG,
        facilitators: entries(),
        discover: async () => {
          reads += 1;
          return snapshot([ensProvider('kev', { payTo: '0.0.666' })]);
        },
        feeds: feeds(),
        ensRetryDelaysMs: [0, 0],
      }),
      (e: unknown) => e instanceof EnsMismatchError,
    );
    assert.equal(reads, 1);
  });

  it('refuses to start when a price differs from ENS (config test)', async () => {
    await assert.rejects(
      prepareProviderService({
        config: CONFIG,
        facilitators: entries(),
        discover: async () =>
          snapshot([ensProvider('kev', { priceAtomic: '999999' }), ensProvider('cve')]),
        feeds: feeds(),
      }),
      (e: unknown) =>
        e instanceof EnsMismatchError &&
        e.mismatches.length === 1 &&
        e.mismatches[0]?.field === 'agent.price' &&
        e.mismatches[0]?.label === 'kev',
    );
  });

  it('refuses to start when a payTo differs or an agent is missing from ENS', async () => {
    await assert.rejects(
      prepareProviderService({
        config: CONFIG,
        facilitators: entries(),
        discover: async () => snapshot([ensProvider('kev', { payTo: '0.0.666' })]),
        feeds: feeds(),
      }),
      (e: unknown) =>
        e instanceof EnsMismatchError &&
        e.mismatches.map((m) => `${m.label}:${m.field}`).join(',') === 'kev:x402.payTo,cve:missing',
    );
  });

  it('refuses to start when the ENS endpoints point at a different URL', async () => {
    await assert.rejects(
      prepareProviderService({
        config: { ...CONFIG, publicUrl: 'https://api.example.onrender.com' },
        facilitators: entries(),
        discover: async () => snapshot(),
        feeds: feeds(),
      }),
      EnsMismatchError,
    );
  });

  it('binds the fallback facilitator when the primary is down, and fails when both are', async () => {
    const { service, report } = await prepareProviderService({
      config: CONFIG,
      facilitators: entries(false, true),
      discover: async () => snapshot(),
      feeds: feeds(),
    });
    assert.equal(report.bound.role, 'fallback');
    assert.equal(report.facilitators[0]?.ok, false);
    const res = await service.app.fetch(
      new Request('http://127.0.0.1:4021/v1/cve/lookup?ids=CVE-2021-44228'),
    );
    const body: unknown = await res.json().catch(() => undefined);
    const req = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
      (n) => res.headers.get(n),
      body,
    ).accepts[0];
    assert.equal(req?.extra['feePayer'], '0.0.9185802', 'quotes the fallback fee payer');

    await assert.rejects(
      prepareProviderService({
        config: CONFIG,
        facilitators: entries(false, false),
        discover: async () => snapshot(),
        feeds: feeds(),
      }),
      (e: unknown) =>
        e instanceof ProviderStartupError && /no facilitator supports exact/.test(e.message),
    );
  });

  it('allows skipping the ENS check only outside production', async () => {
    const dev = await prepareProviderService({
      config: CONFIG,
      facilitators: entries(),
      discover: null,
      feeds: feeds(),
    });
    assert.equal(dev.report.ens.checked, false);
    await assert.rejects(
      prepareProviderService({
        config: { ...CONFIG, production: true },
        facilitators: entries(),
        discover: null,
        feeds: feeds(),
      }),
      /cannot be skipped in production/,
    );
  });

  it('does not contact ENS or open anything when no facilitator is available', async () => {
    let discovered = false;
    await assert.rejects(
      prepareProviderService({
        config: CONFIG,
        facilitators: entries(false, false),
        discover: async () => {
          discovered = true;
          return snapshot();
        },
        feeds: feeds(),
      }),
      ProviderStartupError,
    );
    assert.equal(discovered, false);
  });
});
