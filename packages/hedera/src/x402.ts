/**
 * x402 on Hedera: the paying client and the protected-resource server, wired
 * with the official @x402 packages (exact scheme).
 *
 * Client safety layers, in order, all before any transaction is signed:
 *  1. x402 spend controls: HBAR explicitly allowed, capped per payment.
 *  2. Our deterministic guard (payment-guard.ts) in `beforePaymentCreation`:
 *     network, asset, amount cap, payee allowlist, no self-payment, fee payer.
 * After signing, the transaction ID is read from the payload before it is
 * sent, and the facilitator's settle response is captured for independent
 * Mirror Node verification (settlement.ts).
 */
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { FacilitatorClient } from '@x402/core/server';
import type {
  Network,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import { wrapFetchWithPayment } from '@x402/fetch';
import { createClientHederaSigner } from '@x402/hedera';
import { ExactHederaScheme as ExactHederaClientScheme } from '@x402/hedera/exact/client';
import { Hono } from 'hono';
import {
  evaluatePaymentRequirements,
  type GuardDecision,
  type GuardedRequirements,
  type PaymentGuardPolicy,
} from './payment-guard.ts';
import { parsePrivateKey, transactionIdFromPayload, type KeyType } from './sdk.ts';
import { createPaymentLayer, paymentRoutes } from './x402-server.ts';

/** Re-exported for root scripts (pnpm links @x402/core only into this package). */
export { x402Client, x402HTTPClient };

export const HBAR_ASSET = '0.0.0';
export type HederaCaip2 = 'hedera:testnet' | 'hedera:mainnet';

// ── client ───────────────────────────────────────────────────────────────

/** Everything observed during one paid request, for logging and evidence. */
export interface PaymentRecord {
  requirements?: PaymentRequirements;
  guard?: GuardDecision;
  /** Read from the signed payload before submission. */
  transactionId?: string;
  settle?: SettleResponse;
  settleError?: string;
}

export interface GuardedClientOptions {
  readonly accountId: string;
  readonly privateKey: string;
  readonly keyType: KeyType;
  readonly network: HederaCaip2;
  readonly policy: PaymentGuardPolicy;
  /** HTTP transport; defaults to global fetch. Injected in offline tests. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface GuardedClient {
  readonly client: x402Client;
  readonly httpClient: x402HTTPClient;
  readonly fetchWithPayment: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  /** Mutable record of the most recent payment attempt. */
  readonly record: PaymentRecord;
}

function toGuarded(req: PaymentRequirements): GuardedRequirements {
  return {
    scheme: req.scheme,
    network: req.network,
    asset: req.asset,
    amount: req.amount,
    payTo: req.payTo,
    extra: req.extra,
  };
}

export function createGuardedHederaClient(options: GuardedClientOptions): GuardedClient {
  const record: PaymentRecord = {};
  const signer = createClientHederaSigner(
    options.accountId,
    parsePrivateKey(options.privateKey, options.keyType),
    { network: options.network },
  );

  const client = new x402Client()
    .register(options.network as Network, new ExactHederaClientScheme(signer))
    .setSpendControls({
      // HBAR is not an x402 "default asset", so it must be opted in, with a cap.
      allowedAssets: [
        {
          network: options.network as Network,
          asset: options.policy.asset,
          maxAmountPerPayment: options.policy.maxAmount.toString(),
        },
      ],
    })
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      record.requirements = selectedRequirements;
      const decision = evaluatePaymentRequirements(toGuarded(selectedRequirements), options.policy);
      record.guard = decision;
      if (!decision.ok) return { abort: true, reason: `${decision.code}: ${decision.reason}` };
      return undefined;
    })
    .onAfterPaymentCreation(async ({ paymentPayload }) => {
      const tx = paymentPayload.payload['transaction'];
      if (typeof tx === 'string') record.transactionId = transactionIdFromPayload(tx);
    })
    .onPaymentResponse(async (ctx) => {
      if (ctx.settleResponse !== undefined) record.settle = ctx.settleResponse;
      else if (ctx.error !== undefined) record.settleError = ctx.error.message;
      else if (ctx.paymentRequired !== undefined)
        record.settleError = 'payment rejected at verify (402)';
      return undefined;
    });

  return {
    client,
    httpClient: new x402HTTPClient(client),
    fetchWithPayment: wrapFetchWithPayment(options.fetch ?? fetch, client),
    record,
  };
}

// ── autonomous signer (plan row 21, D-043) ───────────────────────────────

/** Minimal requirement shape shared with the buyer (apps/server/src/payments/x402-buyer.ts). */
export interface SignerRequirement {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface SignerPaymentRequired {
  readonly x402Version: number;
  readonly resourceUrl: string | null;
  readonly accepts: readonly SignerRequirement[];
  readonly raw: unknown;
}

const sameRequirement = (a: SignerRequirement, b: SignerRequirement): boolean =>
  a.scheme === b.scheme &&
  a.network === b.network &&
  a.asset === b.asset &&
  a.amount === b.amount &&
  a.payTo === b.payTo &&
  a.extra?.['feePayer'] === b.extra?.['feePayer'];

/**
 * The Hedera implementation of the buyer's PaymentSigner. It signs only the
 * requirement the firewall authorised: the 402 is narrowed to that single
 * requirement before signing, and the `beforePaymentCreation` hook refuses
 * anything else. The x402 spend cap and the payment guard (D-017) still run
 * first, as the independent second layer; the guard's payee allowlist is the
 * ENS-discovered payees passed in by the caller.
 */
export interface SignerSettle {
  readonly success: boolean;
  readonly transaction: string | null;
  readonly errorReason: string | null;
}

export interface HederaPaymentSigner {
  readonly payer: string;
  parsePaymentRequired(
    getHeader: (name: string) => string | null,
    body: unknown,
  ): SignerPaymentRequired;
  sign(
    required: SignerPaymentRequired,
    requirement: SignerRequirement,
  ): Promise<{ transactionId: string; headers: Record<string, string> }>;
  /** The settle response from the paid response's headers, or null when there is none. */
  parseSettle(getHeader: (name: string) => string | null): SignerSettle | null;
}

export function createHederaPaymentSigner(options: GuardedClientOptions): HederaPaymentSigner {
  let expected: SignerRequirement | null = null;
  const signer = createClientHederaSigner(
    options.accountId,
    parsePrivateKey(options.privateKey, options.keyType),
    { network: options.network },
  );
  const client = new x402Client()
    .register(options.network as Network, new ExactHederaClientScheme(signer))
    .setSpendControls({
      allowedAssets: [
        {
          network: options.network as Network,
          asset: options.policy.asset,
          maxAmountPerPayment: options.policy.maxAmount.toString(),
        },
      ],
    })
    .onBeforePaymentCreation(async ({ selectedRequirements }) => {
      if (
        expected === null ||
        !sameRequirement(toGuarded(selectedRequirements) as SignerRequirement, expected)
      )
        return {
          abort: true,
          reason: 'NOT_AUTHORIZED: requirement differs from the authorised one',
        };
      const decision = evaluatePaymentRequirements(toGuarded(selectedRequirements), options.policy);
      if (!decision.ok) return { abort: true, reason: `${decision.code}: ${decision.reason}` };
      return undefined;
    });
  const http = new x402HTTPClient(client);

  return {
    payer: options.accountId,
    parsePaymentRequired(getHeader, body) {
      const pr = http.getPaymentRequiredResponse((n) => getHeader(n), body);
      return {
        x402Version: pr.x402Version,
        resourceUrl: typeof pr.resource?.url === 'string' ? pr.resource.url : null,
        accepts: pr.accepts.map((r) => ({
          scheme: r.scheme,
          network: r.network,
          asset: r.asset,
          amount: r.amount,
          payTo: r.payTo,
          extra: r.extra,
        })),
        raw: pr,
      };
    },
    async sign(required, requirement) {
      const pr = required.raw as PaymentRequired;
      const match = pr.accepts.find((r) =>
        sameRequirement(toGuarded(r) as SignerRequirement, requirement),
      );
      if (match === undefined)
        throw new Error('NOT_AUTHORIZED: requirement is not in the 402 response');
      // One signature at a time: the hook compares against this single expectation.
      if (expected !== null) throw new Error('SIGNER_BUSY: another payment is being signed');
      expected = requirement;
      try {
        const payload = await client.createPaymentPayload({ ...pr, accepts: [match] });
        const tx = payload.payload['transaction'];
        if (typeof tx !== 'string') throw new Error('payment payload has no transaction');
        return {
          transactionId: transactionIdFromPayload(tx),
          headers: http.encodePaymentSignatureHeader(payload),
        };
      } finally {
        expected = null;
      }
    },
    parseSettle(getHeader) {
      try {
        const s = http.getPaymentSettleResponse((n) => getHeader(n));
        return {
          success: s.success,
          transaction:
            typeof s.transaction === 'string' && s.transaction !== '' ? s.transaction : null,
          errorReason: s.errorReason ?? null,
        };
      } catch {
        return null;
      }
    },
  };
}

// ── server ───────────────────────────────────────────────────────────────

export interface ProviderAppOptions {
  readonly facilitator: FacilitatorClient;
  readonly network: HederaCaip2;
  /** Provider label, e.g. kev; becomes part of the route path. */
  readonly label: string;
  readonly payTo: string;
  readonly priceTinybars: bigint;
}

/** Route path of the Phase 3 paid endpoint for a provider label. */
export function pingPath(label: string): string {
  return `/v1/${label}/ping`;
}

/**
 * Minimal x402-protected service: GET /v1/<label>/ping costs priceTinybars HBAR,
 * paid to payTo and settled through the configured facilitator. Real data
 * routes arrive in Phase 13; this route proves the payment path end to end.
 */
export function createProviderApp(options: ProviderAppOptions): Hono {
  const path = pingPath(options.label);
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.use(
    createPaymentLayer({
      facilitators: options.facilitator,
      network: options.network,
      routes: paymentRoutes(options.network, [
        {
          path,
          priceAtomic: options.priceTinybars.toString(),
          payTo: options.payTo,
          description: `Paid ping for provider ${options.label} (Phase 3 settlement check)`,
        },
      ]),
    }).middleware,
  );

  app.get(path, (c) =>
    c.json({
      provider: options.label,
      paidRoute: path,
      priceTinybars: options.priceTinybars.toString(),
      servedAt: new Date().toISOString(),
    }),
  );

  return app;
}
