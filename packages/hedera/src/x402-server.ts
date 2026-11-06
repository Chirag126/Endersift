/**
 * Shared x402 server configuration (plan row 16): every paid route in the
 * project is declared through `paymentRoutes`, served through
 * `createPaymentLayer`, and settled by facilitators built from env with
 * `facilitatorsFromEnv`.
 *
 * Facilitator fallback is decided at startup, not per payment. x402's
 * resource server takes an ordered list and binds, per (network, scheme),
 * the FIRST facilitator whose /supported answers (x402ResourceServer.initialize
 * in @x402/core 2.28.0). That one quotes the fee payer and later verifies and
 * settles. On Hedera the signed transaction names that fee payer, so a payment
 * prepared for one facilitator can never be settled by another; switching
 * mid-payment would be unsafe, switching at startup is not.
 */
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type FacilitatorClient,
  type RouteConfig,
} from '@x402/core/server';
import type { Network } from '@x402/core/types';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { paymentMiddleware } from '@x402/hono';
import type { MiddlewareHandler } from 'hono';

const ENTITY_ID = /^0\.0\.\d+$/;
const isHederaEntityId = (v: string): boolean => ENTITY_ID.test(v);

export const HBAR = '0.0.0';
export type HederaNetworkId = 'hedera:testnet' | 'hedera:mainnet';

export interface PaidRoute {
  /** Request path, e.g. /v1/kev/recent. Only GET is used in this project. */
  readonly path: string;
  /** Price in atomic units of `asset` (tinybars for HBAR). */
  readonly priceAtomic: string;
  readonly payTo: string;
  readonly description: string;
  readonly asset?: string;
}

export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigError';
  }
}

/** x402 route table for @x402/hono, validated: positive integer prices, Hedera payees, unique paths. */
export function paymentRoutes(
  network: HederaNetworkId,
  routes: readonly PaidRoute[],
): Record<string, RouteConfig> {
  const out: Record<string, RouteConfig> = {};
  for (const r of routes) {
    if (!/^\/[A-Za-z0-9/_-]*$/.test(r.path))
      throw new PaymentConfigError(`invalid route path ${JSON.stringify(r.path)}`);
    if (!/^[1-9]\d*$/.test(r.priceAtomic))
      throw new PaymentConfigError(`invalid price for ${r.path}`);
    if (!isHederaEntityId(r.payTo)) throw new PaymentConfigError(`invalid payTo for ${r.path}`);
    const asset = r.asset ?? HBAR;
    if (!isHederaEntityId(asset)) throw new PaymentConfigError(`invalid asset for ${r.path}`);
    const key = `GET ${r.path}`;
    if (out[key] !== undefined) throw new PaymentConfigError(`duplicate paid route ${r.path}`);
    out[key] = {
      accepts: {
        scheme: 'exact',
        price: { amount: r.priceAtomic, asset },
        network: network as Network,
        payTo: r.payTo,
      },
      description: r.description,
      mimeType: 'application/json',
    };
  }
  return out;
}

export interface PaymentLayer {
  readonly resourceServer: x402ResourceServer;
  readonly middleware: MiddlewareHandler;
}

/** The one place a resource server and the payment middleware are created. */
export function createPaymentLayer(options: {
  readonly facilitators: FacilitatorClient | readonly FacilitatorClient[];
  readonly network: HederaNetworkId;
  readonly routes: Record<string, RouteConfig>;
}): PaymentLayer {
  const list = Array.isArray(options.facilitators)
    ? [...options.facilitators]
    : [options.facilitators];
  const resourceServer = new x402ResourceServer(list as FacilitatorClient[]).register(
    options.network as Network,
    new ExactHederaScheme(),
  );
  return { resourceServer, middleware: paymentMiddleware(options.routes, resourceServer) };
}

export interface FacilitatorEntry {
  readonly role: 'primary' | 'fallback';
  readonly url: string;
  readonly client: FacilitatorClient;
}

/** Primary (X402_FACILITATOR_URL) then optional fallback (X402_FALLBACK_FACILITATOR_URL), in precedence order. */
export function facilitatorsFromEnv(
  primaryUrl: string,
  fallbackUrl: string | undefined,
  make: (url: string) => FacilitatorClient = (url) =>
    new HTTPFacilitatorClient({ url, timeoutMs: 30_000 }),
): FacilitatorEntry[] {
  const norm = (u: string) => u.trim().replace(/\/+$/, '');
  const entries: FacilitatorEntry[] = [
    { role: 'primary', url: norm(primaryUrl), client: make(norm(primaryUrl)) },
  ];
  if (
    fallbackUrl !== undefined &&
    fallbackUrl.trim() !== '' &&
    norm(fallbackUrl) !== norm(primaryUrl)
  ) {
    entries.push({ role: 'fallback', url: norm(fallbackUrl), client: make(norm(fallbackUrl)) });
  }
  return entries;
}

export interface FacilitatorProbe {
  readonly role: 'primary' | 'fallback';
  readonly url: string;
  readonly ok: boolean;
  /** Fee payer advertised for `exact` on the network, when supported. */
  readonly feePayer: string | null;
  readonly error: string | null;
}

/**
 * Ask each facilitator for /supported, in precedence order. `bound` is the
 * entry x402ResourceServer will bind (the first one supporting exact on the
 * network with a valid fee payer); null when none does.
 */
export async function probeFacilitators(
  entries: readonly FacilitatorEntry[],
  network: HederaNetworkId,
): Promise<{ probes: FacilitatorProbe[]; bound: FacilitatorProbe | null }> {
  const probes: FacilitatorProbe[] = [];
  for (const e of entries) {
    try {
      const supported = await e.client.getSupported();
      const kind = supported.kinds.find((k) => k.scheme === 'exact' && k.network === network);
      const feePayer = kind?.extra?.['feePayer'];
      const valid = typeof feePayer === 'string' && isHederaEntityId(feePayer);
      probes.push({
        role: e.role,
        url: e.url,
        ok: valid,
        feePayer: valid ? feePayer : null,
        error:
          kind === undefined
            ? `does not support exact on ${network}`
            : valid
              ? null
              : 'no valid fee payer',
      });
    } catch (error) {
      probes.push({
        role: e.role,
        url: e.url,
        ok: false,
        feePayer: null,
        error:
          (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200) ??
          'error',
      });
    }
  }
  return { probes, bound: probes.find((p) => p.ok) ?? null };
}
