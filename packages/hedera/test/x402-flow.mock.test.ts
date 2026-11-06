// Class: mock. Runs the REAL x402 client (real Hedera transaction signing,
// guard, payload decoding) against the REAL Hono server + x402 middleware,
// with a FAKE facilitator that never touches the network. It proves the
// wiring, not settlement: it is never sponsor evidence. Live settlement is
// verified by `pnpm x402:pay` against Hedera testnet.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { generateEcdsaKey, transactionIdFromPayload } from '../src/sdk.ts';
import {
  createGuardedHederaClient,
  createProviderApp,
  pingPath,
  type PaymentRecord,
} from '../src/x402.ts';

const PAYER = '0.0.1001';
const PAYTO = '0.0.11044329';
const FEE_PAYER = '0.0.7162784';
const PRICE = 100_000n;
const URL_BASE = 'http://provider.test';

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
    async verify(_payload: PaymentPayload, _req: PaymentRequirements) {
      calls.verify += 1;
      return { isValid: true, payer: PAYER };
    },
    async settle(payload: PaymentPayload, req: PaymentRequirements) {
      calls.settle += 1;
      const tx = payload.payload['transaction'];
      assert.equal(typeof tx, 'string');
      return {
        success: true,
        transaction: transactionIdFromPayload(tx as string),
        network: req.network,
        payer: PAYER,
      };
    },
  };
  return { facilitator, calls };
}

function setup(options: { payTo?: string; maxAmount?: bigint } = {}) {
  const { facilitator, calls } = fakeFacilitator();
  const app = createProviderApp({
    facilitator,
    network: 'hedera:testnet',
    label: 'kev',
    payTo: options.payTo ?? PAYTO,
    priceTinybars: PRICE,
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
      maxAmount: options.maxAmount ?? 1_000_000n,
      allowedPayTo: [PAYTO],
      payer: PAYER,
    },
    fetch: appFetch,
  });
  return { app, appFetch, client, calls };
}

const URL_PAID = `${URL_BASE}${pingPath('kev')}`;

describe('provider app (x402 middleware)', () => {
  it('serves /health without payment', async () => {
    const { appFetch } = setup();
    const res = await appFetch(`${URL_BASE}/health`);
    assert.equal(res.status, 200);
  });

  it('answers an unpaid request with 402 and exact Hedera requirements', async () => {
    const { appFetch } = setup();
    const res = await appFetch(URL_PAID);
    assert.equal(res.status, 402);
    const body: unknown = await res.json().catch(() => undefined);
    const required = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse(
      (name) => res.headers.get(name),
      body,
    );
    const req = required.accepts[0];
    assert.ok(req !== undefined);
    assert.equal(req.scheme, 'exact');
    assert.equal(req.network, 'hedera:testnet');
    assert.equal(req.asset, '0.0.0');
    assert.equal(req.amount, PRICE.toString());
    assert.equal(req.payTo, PAYTO);
    assert.equal(req.extra['feePayer'], FEE_PAYER);
  });
});

describe('guarded client against the provider app', () => {
  it('pays autonomously, learns the tx id before submission, and receives the resource', async () => {
    const { client, calls } = setup();
    const res = await client.fetchWithPayment(URL_PAID);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { provider: string };
    assert.equal(body.provider, 'kev');

    const record: PaymentRecord = client.record;
    assert.equal(record.guard?.ok, true);
    assert.match(record.transactionId ?? '', /^0\.0\.7162784@\d+\.\d+$/);
    assert.equal(record.settle?.success, true);
    assert.equal(record.settle?.transaction, record.transactionId);
    assert.deepEqual(calls, { verify: 1, settle: 1 });
  });

  it('refuses a payee outside the allowlist before signing (no verify, no settle)', async () => {
    const { client, calls } = setup({ payTo: '0.0.999' });
    await assert.rejects(client.fetchWithPayment(URL_PAID), /PAYTO_NOT_ALLOWED/);
    assert.equal(client.record.transactionId, undefined);
    assert.deepEqual(calls, { verify: 0, settle: 0 });
  });

  it('refuses a price above the cap before signing (no verify, no settle)', async () => {
    const { client, calls } = setup({ maxAmount: 1_000n });
    await assert.rejects(client.fetchWithPayment(URL_PAID));
    assert.equal(client.record.transactionId, undefined);
    assert.deepEqual(calls, { verify: 0, settle: 0 });
  });
});
