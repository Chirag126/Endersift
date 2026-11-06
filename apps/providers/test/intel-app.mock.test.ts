// Class: mock. The REAL x402 client (real Hedera transaction signing, guard)
// against the REAL Hono app + @x402/hono middleware, with a FAKE facilitator
// and FAKE upstream feeds (synthetic fixtures). Proves the wiring of each paid
// route; never sponsor evidence. Live settlement: `pnpm x402:pay -- --url …`.
// CI only (needs the @x402 packages).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IntelResponse } from '@agent-economy/core/domain';
import { generateEcdsaKey, transactionIdFromPayload } from '@agent-economy/hedera/sdk';
import { createGuardedHederaClient } from '@agent-economy/hedera/x402';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { PROVIDER_SECURITY_HEADERS, createIntelApp } from '../src/app.ts';
import { NoBriefError } from '../src/brief.ts';
import { toPublicRequest } from '../src/public-url.ts';
import { KevFeed } from '../src/feeds/kev.ts';
import { NvdClient } from '../src/feeds/nvd.ts';
import { OsvClient } from '../src/feeds/osv.ts';
import { KEV_FIXTURE, NVD_FIXTURE, OSV_FIXTURE } from './fixtures.ts';

const PAYER = '0.0.1001';
const FEE_PAYER = '0.0.7162784';
const BASE = 'http://127.0.0.1:4021';
const PROVIDERS = [
  { label: 'kev', payTo: '0.0.11044329', priceAtomic: '100000' },
  { label: 'cve', payTo: '0.0.11183141', priceAtomic: '150000' },
  { label: 'osv', payTo: '0.0.11183142', priceAtomic: '120000' },
];
const ROUTES = {
  kev: '/v1/kev/recent?since=2099-01-01&limit=10',
  cve: '/v1/cve/lookup?ids=CVE-2099-0001,CVE-2099-0404',
  osv: '/v1/osv/query?ecosystem=npm&package=example-lib&version=4.17.20',
} as const;

function fakeFacilitator() {
  const calls = { verify: 0, settle: 0 };
  const facilitator: FacilitatorClient = {
    async getSupported() {
      return {
        kinds: [
          {
            x402Version: 2,
            scheme: 'exact',
            network: 'hedera:testnet',
            extra: { feePayer: FEE_PAYER },
          },
        ],
        extensions: [],
        signers: { 'hedera:*': [FEE_PAYER] },
      };
    },
    async verify(_p: PaymentPayload, _r: PaymentRequirements) {
      calls.verify += 1;
      return { isValid: true, payer: PAYER };
    },
    async settle(payload: PaymentPayload, req: PaymentRequirements) {
      calls.settle += 1;
      return {
        success: true,
        transaction: transactionIdFromPayload(payload.payload['transaction'] as string),
        network: req.network,
        payer: PAYER,
      };
    },
  };
  return { facilitator, calls };
}

const json = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });

function setup(options: { upstreamDown?: boolean } = {}) {
  const { facilitator, calls } = fakeFacilitator();
  const down = async () => new Response('down', { status: 500 });
  const nvdFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    return url.includes('CVE-2099-0001')
      ? new Response(JSON.stringify(NVD_FIXTURE))
      : new Response(JSON.stringify({ totalResults: 0, vulnerabilities: [] }));
  }) as typeof fetch;
  const app = createIntelApp({
    facilitators: facilitator,
    network: 'hedera:testnet',
    providers: PROVIDERS,
    pingPriceTinybars: 100_000n,
    now: () => new Date('2099-01-15T12:00:00.000Z'),
    feeds: {
      kev: new KevFeed({
        fetch: (options.upstreamDown ? down : json(KEV_FIXTURE)) as typeof fetch,
      }),
      nvd: new NvdClient({ fetch: options.upstreamDown ? (down as typeof fetch) : nvdFetch }),
      osv: new OsvClient({
        fetch: (options.upstreamDown ? down : json(OSV_FIXTURE)) as typeof fetch,
      }),
    },
  });
  const appFetch = (async (input: string | URL | Request, init?: RequestInit) =>
    app.fetch(new Request(input, init))) as typeof fetch;
  const client = createGuardedHederaClient({
    accountId: PAYER,
    privateKey: generateEcdsaKey().toStringRaw(),
    keyType: 'ecdsa',
    network: 'hedera:testnet',
    policy: {
      network: 'hedera:testnet',
      asset: '0.0.0',
      maxAmount: 1_000_000n,
      allowedPayTo: PROVIDERS.map((p) => p.payTo),
      payer: PAYER,
    },
    fetch: appFetch,
  });
  return { app, appFetch, client, calls };
}

async function requirements(res: Response) {
  const body: unknown = await res.json().catch(() => undefined);
  const required = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
    (name) => res.headers.get(name),
    body,
  );
  return required.accepts[0];
}

describe('threat-intel provider routes (x402)', () => {
  it('serves health and a free description of each agent', async () => {
    const { appFetch, calls } = setup();
    const health = await appFetch(`${BASE}/health`);
    assert.equal(health.status, 200);
    // readable from the agent's web app, which wakes this host from the browser (D-085)
    assert.equal(health.headers.get('access-control-allow-origin'), '*');
    // only /health: a catalog is not opened to other pages
    assert.equal(
      (await appFetch(`${BASE}/v1/cve`)).headers.get('access-control-allow-origin'),
      null,
    );
    const desc = (await (await appFetch(`${BASE}/v1/cve`)).json()) as {
      operations: { path: string; payment: { amount: string; payTo: string } }[];
    };
    assert.equal(desc.operations[0]?.path, '/v1/cve/lookup');
    assert.equal(desc.operations[0]?.payment.amount, '150000');
    assert.equal(desc.operations[0]?.payment.payTo, '0.0.11183141');
    assert.deepEqual(calls, { verify: 0, settle: 0 });
  });

  it('the USDC lane quotes Circle USDC to the same payout account (D-064)', async () => {
    const { facilitator } = fakeFacilitator();
    const app = createIntelApp({
      facilitators: facilitator,
      network: 'hedera:testnet',
      providers: PROVIDERS,
      usdcPing: { tokenId: '0.0.429274', priceAtomic: 10_000n },
      // the fixtures' dates are in 2099: pin the clock like setup() does
      now: () => new Date('2099-01-15T12:00:00.000Z'),
      feeds: {
        kev: new KevFeed({ fetch: json(KEV_FIXTURE) as typeof fetch }),
        nvd: new NvdClient({
          fetch: json({ totalResults: 0, vulnerabilities: [] }) as typeof fetch,
        }),
        osv: new OsvClient({ fetch: json(OSV_FIXTURE) as typeof fetch }),
      },
    });
    const res = await app.fetch(new Request(`${BASE}/v1/kev/ping-usdc`));
    assert.equal(res.status, 402);
    const req = await requirements(res);
    assert.equal(req?.asset, '0.0.429274');
    assert.equal(req?.amount, '10000');
    assert.equal(req?.payTo, '0.0.11044329');
    // the HBAR routes are unchanged
    const hbar = await requirements(await app.fetch(new Request(`${BASE}${ROUTES.kev}`)));
    assert.equal(hbar?.asset, '0.0.0');
  });

  it('behind a TLS proxy the 402 quote names the public https resource (D-062)', async () => {
    const { app } = setup();
    // what Render forwards: plain http on the public host
    const forwarded = new Request(`http://providers.example${ROUTES.kev}`);
    const res = await app.fetch(toPublicRequest(forwarded, 'https://providers.example'));
    assert.equal(res.status, 402);
    const body: unknown = await res.json().catch(() => undefined);
    const required = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
      (name) => res.headers.get(name),
      body,
    );
    assert.equal(required.resource.url, `https://providers.example${ROUTES.kev}`);
  });

  it('security headers on free, unpaid (402) and refused (400) responses (D-060)', async () => {
    const { appFetch } = setup();
    const responses = [
      await appFetch(`${BASE}/health`),
      await appFetch(`${BASE}${ROUTES.cve}`),
      await appFetch(`${BASE}/v1/cve/lookup?ids=not-a-cve`),
    ];
    assert.deepEqual(
      responses.map((r) => r.status),
      [200, 402, 400],
    );
    for (const res of responses)
      for (const [name, value] of Object.entries(PROVIDER_SECURITY_HEADERS))
        assert.equal(res.headers.get(name), value, `${res.status} ${name}`);
  });

  for (const p of PROVIDERS) {
    const route = ROUTES[p.label as keyof typeof ROUTES];

    it(`${p.label}: unpaid → 402 with this agent's price and payTo`, async () => {
      const { appFetch } = setup();
      const res = await appFetch(`${BASE}${route}`);
      assert.equal(res.status, 402);
      const req = await requirements(res);
      assert.equal(req?.scheme, 'exact');
      assert.equal(req?.network, 'hedera:testnet');
      assert.equal(req?.asset, '0.0.0');
      assert.equal(req?.amount, p.priceAtomic);
      assert.equal(req?.payTo, p.payTo);
    });

    it(`${p.label}: paid → 200 with normalised, schema-valid data; settled once`, async () => {
      const { client, calls } = setup();
      const res = await client.fetchWithPayment(`${BASE}${route}`);
      assert.equal(res.status, 200);
      const body = IntelResponse.parse(await res.json());
      assert.equal(body.provider, p.label);
      assert.ok(body.count > 0);
      assert.equal(client.record.requirements?.payTo, p.payTo);
      assert.match(client.record.transactionId ?? '', /^0\.0\.7162784@\d+\.\d+$/);
      assert.deepEqual(calls, { verify: 1, settle: 1 });
    });
  }

  it('reports unknown CVE IDs in notFound', async () => {
    const { client } = setup();
    const body = IntelResponse.parse(
      await (await client.fetchWithPayment(`${BASE}${ROUTES.cve}`)).json(),
    );
    assert.deepEqual(
      body.items.map((i) => i.id),
      ['CVE-2099-0001'],
    );
    assert.deepEqual(body.notFound, ['CVE-2099-0404']);
  });

  it('rejects a malformed query with 400 before any payment is requested', async () => {
    const { appFetch, client, calls } = setup();
    const res = await appFetch(`${BASE}/v1/cve/lookup?ids=not-a-cve`);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('payment-required'), null);
    const paid = await client.fetchWithPayment(`${BASE}/v1/kev/recent?limit=0`);
    assert.equal(paid.status, 400);
    assert.equal(client.record.transactionId, undefined, 'nothing signed');
    assert.deepEqual(calls, { verify: 0, settle: 0 });
  });

  it('does not settle when the upstream feed fails (payer not charged)', async () => {
    const { client, calls } = setup({ upstreamDown: true });
    for (const route of Object.values(ROUTES)) {
      const res = await client.fetchWithPayment(`${BASE}${route}`);
      assert.equal(res.status, 502, route);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /not charged/);
    }
    assert.equal(calls.verify, 3, 'payments were verified');
    assert.equal(calls.settle, 0, 'but never settled');
  });

  it('the agent earns (D-066): the brief is quoted to the earnings account, settled only when it is read', async () => {
    const { facilitator, calls } = fakeFacilitator();
    const EARN = '0.0.7777001';
    let available = true;
    const brief = {
      runId: '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a',
      watchlist: ['OpenSSL'],
      finishedAt: '2099-01-15T00:20:00.000Z',
      environment: 'live' as const,
      verdict: 'e2e-verified',
      digest: null,
      markdown: '# Threat brief',
    };
    const app = createIntelApp({
      facilitators: facilitator,
      network: 'hedera:testnet',
      providers: PROVIDERS,
      now: () => new Date('2099-01-15T12:00:00.000Z'),
      feeds: {
        kev: new KevFeed({ fetch: json(KEV_FIXTURE) as typeof fetch }),
        nvd: new NvdClient({
          fetch: json({ totalResults: 0, vulnerabilities: [] }) as typeof fetch,
        }),
        osv: new OsvClient({ fetch: json(OSV_FIXTURE) as typeof fetch }),
      },
      briefSale: {
        priceTinybars: 200_000n,
        payTo: EARN,
        read: async () => {
          if (!available) throw new NoBriefError();
          return brief;
        },
      },
      identity: {
        publicUrl: 'https://providers.example',
        parent: 'chirag126.eth',
        chainId: 11155111,
        identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
        agentIds: { kev: '42' },
        descriptions: { kev: 'CISA KEV, served as a paid x402 API.' },
        agentUrl: 'https://agent.example',
      },
    });
    const desc = (await (await app.fetch(new Request(`${BASE}/v1/agent`))).json()) as {
      operations: { path: string; payment: { payTo: string; amount: string } }[];
    };
    assert.equal(desc.operations[0]?.path, '/v1/agent/brief');
    assert.equal(desc.operations[0]?.payment.payTo, EARN);
    const quote = await requirements(await app.fetch(new Request(`${BASE}/v1/agent/brief`)));
    assert.equal(quote?.payTo, EARN);
    assert.equal(quote?.amount, '200000');
    assert.equal(quote?.asset, '0.0.0');
    const appFetch = (async (input: string | URL | Request, init?: RequestInit) =>
      app.fetch(new Request(input, init))) as typeof fetch;
    const buyer = createGuardedHederaClient({
      accountId: PAYER,
      privateKey: generateEcdsaKey().toStringRaw(),
      keyType: 'ecdsa',
      network: 'hedera:testnet',
      policy: {
        network: 'hedera:testnet',
        asset: '0.0.0',
        maxAmount: 1_000_000n,
        allowedPayTo: [EARN],
        payer: PAYER,
      },
      fetch: appFetch,
    });
    const paid = await buyer.fetchWithPayment(`${BASE}/v1/agent/brief`);
    assert.equal(paid.status, 200);
    const body = (await paid.json()) as { provider: string; brief: { runId: string } };
    assert.equal(body.provider, 'agent');
    assert.equal(body.brief.runId, brief.runId);
    assert.deepEqual(calls, { verify: 1, settle: 1 });
    // no brief yet: 404, and the payer is not charged
    available = false;
    const none = await buyer.fetchWithPayment(`${BASE}/v1/agent/brief`);
    assert.equal(none.status, 404);
    assert.equal(calls.settle, 1, 'never settled');
    // ERC-8004 registration files
    const kev = (await (
      await app.fetch(new Request(`${BASE}/.well-known/erc-8004/kev.json`))
    ).json()) as { name: string; x402Support: boolean; registrations: { agentId: number }[] };
    assert.equal(kev.name, 'kev.chirag126.eth');
    assert.equal(kev.x402Support, true);
    assert.deepEqual(
      kev.registrations.map((r) => r.agentId),
      [42],
    );
    const cve = (await (
      await app.fetch(new Request(`${BASE}/.well-known/erc-8004/cve.json`))
    ).json()) as { registrations: unknown[] };
    assert.deepEqual(cve.registrations, [], 'not registered yet: no ID claimed');
    assert.equal(
      (await app.fetch(new Request(`${BASE}/.well-known/erc-8004/nope.json`))).status,
      404,
    );
    const health = (await (await app.fetch(new Request(`${BASE}/health`))).json()) as {
      briefForSale: boolean;
    };
    assert.equal(health.briefForSale, true);
  });

  it('keeps the Phase 3 ping settlement check for every agent', async () => {
    const { client, calls } = setup();
    const res = await client.fetchWithPayment(`${BASE}/v1/osv/ping`);
    assert.equal(res.status, 200);
    assert.equal(client.record.requirements?.payTo, '0.0.11183142');
    assert.deepEqual(calls, { verify: 1, settle: 1 });
  });
});
