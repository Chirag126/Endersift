/**
 * The x402-protected threat-intel service (plan row 15): one Hono app serving
 * every provider agent under its ENS endpoint path.
 *
 * Request order, per paid route:
 *   1. query validation (free): a bad request gets 400 and is never priced;
 *   2. @x402/hono payment middleware: unpaid → 402 with exact Hedera
 *      requirements (price and payTo of THIS agent); paid → verified;
 *   3. handler: fetch + normalise + validate against the zod IntelResponse.
 * @x402/hono 2.28.0 settles only when the handler's status is < 400, and
 * releases the body only after settlement succeeds. Upstream failures return
 * 502/503/504, so the payer is never charged for an error.
 */
import { IntelResponse } from '@agent-economy/core/domain';
import { HBAR_ASSET, type HederaCaip2 } from '@agent-economy/hedera/x402';
import {
  createPaymentLayer,
  paymentRoutes,
  type PaidRoute,
  type PaymentLayer,
} from '@agent-economy/hedera/x402-server';
import {
  NEAR_GUARD_SCHEME,
  NEAR_PAYMENT_HEADER,
  QuoteBook,
  parsePaymentHeader,
  quoteJson,
  type GuardReceipt,
  type NearNetwork,
} from '@agent-economy/near';
import type { FacilitatorClient } from '@x402/core/server';
import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { registrationFile, agentRegistryId } from '@agent-economy/ens/erc8004';
import { NoBriefError, type BriefSale } from './brief.ts';
import { UpstreamError } from './feeds/http.ts';
import { OPERATIONS, operationPath, type Feeds, type Operation } from './operations.ts';

/** Headers on every provider response (D-060). No CORS: buyers are servers, not pages. */
export const PROVIDER_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

export interface IntelProvider {
  readonly label: string;
  readonly payTo: string;
  /** Price per paid request in tinybars (the agent's ENS `agent.price`). */
  readonly priceAtomic: string;
}

export interface IntelAppOptions {
  /** In precedence order: the first that supports exact on the network is bound at startup. */
  readonly facilitators: FacilitatorClient | readonly FacilitatorClient[];
  readonly network: HederaCaip2;
  readonly providers: readonly IntelProvider[];
  readonly feeds: Feeds;
  readonly now?: () => Date;
  /** Keeps the Phase 3 `/v1/<label>/ping` settlement check, at this price. */
  readonly pingPriceTinybars?: bigint;
  /**
   * The USDC lane (plan row 37, D-064): `/v1/<label>/ping-usdc`, paid in this
   * HTS token at this atomic price, to the same payout account. Absent = off.
   */
  readonly usdcPing?: { readonly tokenId: string; readonly priceAtomic: bigint };
  /** The agent earns (D-066): `/v1/agent/brief`, its latest brief, paid to its own account. */
  readonly briefSale?: BriefSale;
  /** ERC-8004 registration files for the agents (D-066). Absent = not served. */
  readonly identity?: ProviderIdentity;
  /** The NEAR pay lane: the same operations under /near, paid through the guard contract. */
  readonly near?: NearLane;
}

/**
 * The NEAR pay lane. An unpaid request gets HTTP 402 with a quote; the buyer
 * pays the quote through the guard contract and asks again with the receipt
 * id; the receipt is read back from the contract before any data is served.
 */
export interface NearLane {
  readonly network: NearNetwork;
  /** The guard contract account. */
  readonly guard: string;
  /** Price of one paid request (yoctoNEAR). */
  readonly priceYocto: bigint;
  /** label → NEAR payout account (the accounts the guard registry lists). */
  readonly accounts: Readonly<Record<string, string>>;
  /** Reads one receipt from the guard contract; null = no such receipt. */
  readonly receipt: (id: number) => Promise<GuardReceipt | null>;
  /** Tests replace the random nonce. */
  readonly nonce?: () => string;
}

/** What the ERC-8004 registration files say (D-066). */
export interface ProviderIdentity {
  /** This service's public base URL (the agents' ENS endpoints are under it). */
  readonly publicUrl: string;
  /** The ENS parent name, e.g. chirag126.eth. */
  readonly parent: string;
  readonly chainId: number;
  readonly identityRegistry: string;
  /** label → agentId, from deployments/sepolia.json once registered. */
  readonly agentIds: Readonly<Record<string, string>>;
  /** label → one-line description (the ENS `description` record). */
  readonly descriptions: Readonly<Record<string, string>>;
  /** The agent's own public URL (its web app), or null. */
  readonly agentUrl: string | null;
}

export interface IntelApp {
  readonly app: Hono;
  /** Exposed so startup can initialise it (bind a facilitator) before listening. */
  readonly payment: PaymentLayer;
}

export function createIntelApp(options: IntelAppOptions): Hono {
  return createIntelService(options).app;
}

export function createIntelService(options: IntelAppOptions): IntelApp {
  const now = options.now ?? (() => new Date());
  const app = new Hono();
  const paid: PaidRoute[] = [];
  const bound: { provider: IntelProvider; op: Operation; path: string }[] = [];

  for (const provider of options.providers) {
    const op = OPERATIONS[provider.label];
    if (op === undefined)
      throw new Error(`no operation is defined for provider "${provider.label}"`);
    const path = operationPath(provider.label, op.name);
    bound.push({ provider, op, path });
    paid.push({
      path,
      priceAtomic: provider.priceAtomic,
      payTo: provider.payTo,
      description: `${provider.label}: ${op.description}`,
    });
    if (options.pingPriceTinybars !== undefined) {
      paid.push({
        path: `/v1/${provider.label}/ping`,
        priceAtomic: options.pingPriceTinybars.toString(),
        payTo: provider.payTo,
        description: `Paid ping for provider ${provider.label} (settlement check)`,
      });
    }
    if (options.usdcPing !== undefined) {
      paid.push({
        path: `/v1/${provider.label}/ping-usdc`,
        priceAtomic: options.usdcPing.priceAtomic.toString(),
        payTo: provider.payTo,
        asset: options.usdcPing.tokenId,
        description: `Paid ping for provider ${provider.label} in USDC (HTS settlement check)`,
      });
    }
  }
  const brief = options.briefSale;
  if (brief !== undefined)
    paid.push({
      path: '/v1/agent/brief',
      priceAtomic: brief.priceTinybars.toString(),
      payTo: brief.payTo,
      description: "agent: the agent's latest threat brief (watchlist, priorities, changes)",
    });
  const payment = createPaymentLayer({
    facilitators: options.facilitators,
    network: options.network,
    routes: paymentRoutes(options.network, paid),
  });

  // Data, not documents (D-060): on every response, 402s and errors included.
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(PROVIDER_SECURITY_HEADERS))
      c.res.headers.set(name, value);
  });

  // readable from any page (no cookies, no secrets): the agent's web app wakes this host from the
  // visitor's browser and shows whether it is up (D-085)
  app.get('/health', (c) => {
    c.header('access-control-allow-origin', '*');
    return c.json({
      status: 'ok',
      providers: bound.map((b) => b.provider.label),
      briefForSale: brief !== undefined,
      nearLane: options.near !== undefined,
    });
  });

  // ERC-8004 registration files (D-066): the agentURI of each registered agent
  const identity = options.identity;
  if (identity !== undefined) {
    const labels = new Set(bound.map((b) => b.provider.label));
    const fileOf = (label: string) => {
      if (labels.has(label))
        return registrationFile({
          name: `${label}.${identity.parent}`,
          description:
            identity.descriptions[label] ?? `Provider agent "${label}", served as a paid x402 API.`,
          services: [
            { name: 'web', endpoint: `${identity.publicUrl}/v1/${label}` },
            { name: 'ENS', endpoint: `${label}.${identity.parent}` },
          ],
          x402Support: true,
          agentId: identity.agentIds[label] ?? null,
          chainId: identity.chainId,
          identityRegistry: identity.identityRegistry,
        });
      if (label === 'agent')
        return registrationFile({
          name: `${identity.parent} threat-intel agent`,
          description:
            'Buys threat intelligence from providers it finds on ENS, pays them over x402 on Hedera within owner-set limits, and writes a daily brief with 0G inference.' +
            (brief === undefined ? '' : ' Sells its latest brief over x402.'),
          services: [
            ...(identity.agentUrl === null ? [] : [{ name: 'web', endpoint: identity.agentUrl }]),
            { name: 'ENS', endpoint: identity.parent },
            ...(brief === undefined
              ? []
              : [{ name: 'x402', endpoint: `${identity.publicUrl}/v1/agent/brief` }]),
          ],
          x402Support: brief !== undefined,
          agentId: identity.agentIds['agent'] ?? null,
          chainId: identity.chainId,
          identityRegistry: identity.identityRegistry,
        });
      return null;
    };
    app.get('/.well-known/erc-8004/:file', (c) => {
      const m = /^([a-z0-9-]{1,63})\.json$/.exec(c.req.param('file'));
      const file = m === null ? null : fileOf(m[1] ?? '');
      return file === null ? c.json({ error: 'no such agent' }, 404) : c.json(file);
    });
    // endpoint-domain verification (ERC-8004): the registrations served from this domain
    app.get('/.well-known/agent-registration.json', (c) =>
      c.json({
        registrations: Object.entries(identity.agentIds)
          .filter(([label]) => labels.has(label) || label === 'agent')
          .map(([, id]) => ({
            agentId: Number(id),
            agentRegistry: agentRegistryId(identity.chainId, identity.identityRegistry),
          })),
      }),
    );
  }

  // the agent's brief for sale (D-066): free description, like the providers' catalogs
  if (brief !== undefined)
    app.get('/v1/agent', (c) =>
      c.json({
        provider: 'agent',
        operations: [
          {
            name: 'brief',
            method: 'GET',
            path: '/v1/agent/brief',
            description:
              "The agent's latest finished threat brief: watchlist, priorities and what changed since the previous brief.",
            params: {},
            payment: {
              scheme: 'exact',
              network: options.network,
              asset: HBAR_ASSET,
              amount: brief.priceTinybars.toString(),
              payTo: brief.payTo,
            },
          },
        ],
      }),
    );

  // Free: what each agent sells, at what price, paid to whom (mirrors its ENS records).
  for (const { provider, op, path } of bound) {
    app.get(`/v1/${provider.label}`, (c) =>
      c.json({
        provider: provider.label,
        operations: [
          {
            name: op.name,
            method: 'GET',
            path,
            description: op.description,
            params: op.params,
            payment: {
              scheme: 'exact',
              network: options.network,
              asset: HBAR_ASSET,
              amount: provider.priceAtomic,
              payTo: provider.payTo,
            },
          },
        ],
      }),
    );
    // 1. Validation before payment: a malformed query is never priced.
    app.use(path, async (c, next) => {
      const result = op.validate(new URL(c.req.url).searchParams, now());
      if (!result.ok) return c.json({ error: result.error }, 400);
      await next();
      return undefined;
    });
  }

  // The answer to a paid request, shared by both pay lanes: fetch, normalise, validate.
  const answer = async (c: Context, provider: IntelProvider, op: Operation): Promise<Response> => {
    const result = op.validate(new URL(c.req.url).searchParams, now());
    if (!result.ok) return c.json({ error: result.error }, 400);
    try {
      const out = await op.run(result.query, options.feeds);
      const body = {
        provider: provider.label,
        operation: op.name,
        source: out.source,
        query: result.query,
        count: out.items.length,
        truncated: out.truncated,
        notFound: out.notFound,
        items: out.items,
        servedAt: now().toISOString(),
      };
      const checked = IntelResponse.safeParse(body);
      if (!checked.success) {
        return c.json({ error: 'upstream data failed validation; not charged' }, 502);
      }
      return c.json(checked.data);
    } catch (error) {
      if (error instanceof UpstreamError) {
        if (error.retryAfterSeconds !== null)
          c.header('Retry-After', String(error.retryAfterSeconds));
        return c.json({ error: `${error.message}; not charged` }, error.status);
      }
      return c.json({ error: 'internal error; not charged' }, 500);
    }
  };

  // The NEAR pay lane, mounted before the x402 middleware (which only knows the Hedera routes).
  const near = options.near;
  if (near !== undefined) {
    const quotes = new QuoteBook({
      network: near.network,
      guard: near.guard,
      nonce: near.nonce ?? (() => randomBytes(16).toString('hex')),
      now: () => now().getTime(),
    });
    for (const { provider, op, path } of bound) {
      const payTo = near.accounts[provider.label];
      if (payTo === undefined) continue;
      const nearPath = `/near${path}`;
      app.get(`/near/v1/${provider.label}`, (c) =>
        c.json({
          provider: provider.label,
          operations: [
            {
              name: op.name,
              method: 'GET',
              path: nearPath,
              description: op.description,
              params: op.params,
              payment: {
                scheme: NEAR_GUARD_SCHEME,
                network: near.network,
                guard: near.guard,
                amount: near.priceYocto.toString(),
                payTo,
              },
            },
          ],
        }),
      );
      app.get(nearPath, async (c) => {
        const url = new URL(c.req.url);
        // 1. validation before payment: a malformed query is never priced
        const valid = op.validate(url.searchParams, now());
        if (!valid.ok) return c.json({ error: valid.error }, 400);
        const resource = `${url.pathname}${url.search}`;
        const quote = (error: string) =>
          c.json(
            { error, accepts: [quoteJson(quotes.issue(resource, payTo, near.priceYocto))] },
            402,
          );
        // 2. payment: the receipt named in the header, read back from the guard contract
        const payment = parsePaymentHeader(c.req.header(NEAR_PAYMENT_HEADER));
        if (payment === null) return quote('payment required');
        let receipt: GuardReceipt | null;
        try {
          receipt = await near.receipt(payment.receiptId);
        } catch {
          return c.json(
            { error: 'could not read the guard contract; ask again with the same payment' },
            503,
          );
        }
        const paid = quotes.check(payment.nonce, resource, receipt);
        if (!paid.ok) return quote(paid.reason);
        // 3. the answer; the quote is used up only once the data has been served
        const response = await answer(c, provider, op);
        if (response.status === 200) quotes.consume(payment.nonce);
        return response;
      });
    }
  }

  // 2. Payment.
  app.use(payment.middleware);

  // 3. Paid handlers.
  for (const { provider, op, path } of bound) {
    app.get(path, (c) => answer(c, provider, op));
    if (options.pingPriceTinybars !== undefined) {
      const price = options.pingPriceTinybars;
      app.get(`/v1/${provider.label}/ping`, (c) =>
        c.json({
          provider: provider.label,
          paidRoute: `/v1/${provider.label}/ping`,
          priceTinybars: price.toString(),
          servedAt: now().toISOString(),
        }),
      );
    }
    if (options.usdcPing !== undefined) {
      const usdc = options.usdcPing;
      app.get(`/v1/${provider.label}/ping-usdc`, (c) =>
        c.json({
          provider: provider.label,
          paidRoute: `/v1/${provider.label}/ping-usdc`,
          asset: usdc.tokenId,
          priceAtomic: usdc.priceAtomic.toString(),
          servedAt: now().toISOString(),
        }),
      );
    }
  }

  if (brief !== undefined)
    app.get('/v1/agent/brief', async (c) => {
      try {
        const b = await brief.read();
        return c.json({
          provider: 'agent',
          operation: 'brief',
          brief: b,
          servedAt: now().toISOString(),
        });
      } catch (error) {
        if (error instanceof NoBriefError) return c.json({ error: error.message }, 404);
        if (error instanceof UpstreamError)
          return c.json({ error: `${error.message}; not charged` }, error.status);
        return c.json({ error: 'internal error; not charged' }, 500);
      }
    });

  return { app, payment };
}
