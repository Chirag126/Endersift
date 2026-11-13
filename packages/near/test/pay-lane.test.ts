import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NEAR_PAYMENT_HEADER,
  QuoteBook,
  base58Encode,
  buyFromProvider,
  encodeTransaction,
  generateKeyPair,
  parseNear,
  parsePaymentHeader,
  parseQuote,
  paymentHeader,
  quoteJson,
  signerFromSecretKey,
  type Assessment,
  type BuyDeps,
  type GuardPayResult,
  type GuardProvider,
  type GuardReceipt,
} from '../src/index.ts';

const GUARD = 'guard.endersift.testnet';
const KEV = 'kev.endersift.testnet';
const PRICE = parseNear('0.001');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function book(now = { ms: 1_000_000 }) {
  let n = 0;
  const quotes = new QuoteBook({
    network: 'near:testnet',
    guard: GUARD,
    ttlMs: 60_000,
    max: 3,
    now: () => now.ms,
    nonce: () => (n += 1).toString(16).padStart(32, '0'),
  });
  return { quotes, now };
}

const receipt = (over: Partial<GuardReceipt> = {}): GuardReceipt => ({
  id: 4,
  runId: 'run-1',
  receiver: KEV,
  amount: PRICE,
  memo: '0'.repeat(31) + '1',
  status: 'Paid',
  passed: null,
  atMs: 1,
  ...over,
});

describe('QuoteBook', () => {
  it('accepts the receipt that pays its quote, once', () => {
    const { quotes } = book();
    const q = quotes.issue('/near/v1/kev/lookup?cve=CVE-2021-44228', KEV, PRICE);
    assert.equal(q.nonce, '0'.repeat(31) + '1');
    const resource = '/near/v1/kev/lookup?cve=CVE-2021-44228';
    assert.deepEqual(quotes.check(q.nonce, resource, receipt()), { ok: true });
    // not consumed by the check: a failed upstream call can be asked again
    assert.deepEqual(quotes.check(q.nonce, resource, receipt()), { ok: true });
    quotes.consume(q.nonce);
    assert.equal(quotes.check(q.nonce, resource, receipt()).ok, false);
  });

  it('refuses a receipt that does not pay this quote', () => {
    const { quotes } = book();
    const q = quotes.issue('/a', KEV, PRICE);
    const reason = (r: GuardReceipt | null, resource = '/a') => {
      const out = quotes.check(q.nonce, resource, r);
      return out.ok ? 'ok' : out.reason;
    };
    assert.match(reason(null), /no such receipt/);
    assert.match(reason(receipt({ status: 'Pending' })), /pending/);
    assert.match(reason(receipt({ status: 'Failed' })), /failed/);
    assert.match(reason(receipt({ receiver: 'cve.endersift.testnet' })), /another account/);
    assert.match(reason(receipt({ amount: PRICE - 1n })), /less than the price/);
    assert.match(reason(receipt({ memo: 'f'.repeat(32) })), /another quote/);
    assert.match(reason(receipt(), '/b'), /another request/);
    assert.match(
      (() => {
        const out = quotes.check('f'.repeat(32), '/a', receipt());
        return out.ok ? 'ok' : out.reason;
      })(),
      /unknown or already used/,
    );
  });

  it('expires quotes and keeps at most `max`', () => {
    const { quotes, now } = book();
    const q = quotes.issue('/a', KEV, PRICE);
    now.ms += 60_000;
    assert.match(
      (() => {
        const out = quotes.check(q.nonce, '/a', receipt());
        return out.ok ? 'ok' : out.reason;
      })(),
      /expired/,
    );
    for (let i = 0; i < 5; i += 1) quotes.issue(`/r${i}`, KEV, PRICE);
    assert.equal(quotes.size, 3);
  });
});

describe('quotes and headers on the wire', () => {
  it('round-trips a quote through its 402 body', () => {
    const { quotes } = book();
    const q = quotes.issue('/a', KEV, PRICE);
    const parsed = parseQuote(JSON.parse(JSON.stringify({ accepts: [quoteJson(q)] })));
    assert.deepEqual(parsed, q);
  });

  it('rejects malformed quotes', () => {
    const { quotes } = book();
    const good = quoteJson(quotes.issue('/a', KEV, PRICE));
    for (const bad of [
      {},
      { accepts: [] },
      { accepts: [{ ...good, scheme: 'exact' }] },
      { accepts: [{ ...good, network: 'near:localnet' }] },
      { accepts: [{ ...good, payTo: 'NOT AN ACCOUNT' }] },
      { accepts: [{ ...good, amount: 5 }] },
      { accepts: [{ ...good, amount: '-5' }] },
      { accepts: [{ ...good, nonce: 'xyz' }] },
      { accepts: [{ ...good, expiresAt: 'soon' }] },
    ])
      assert.throws(() => parseQuote(bad));
  });

  it('reads the payment header strictly', () => {
    const nonce = 'a'.repeat(32);
    assert.deepEqual(parsePaymentHeader(paymentHeader(nonce, 12)), { nonce, receiptId: 12 });
    for (const bad of [undefined, null, '', 'abc:1', `${nonce}:`, `${nonce}:-1`, `${nonce}:1.5`])
      assert.equal(parsePaymentHeader(bad), null);
    assert.equal(NEAR_PAYMENT_HEADER, 'x-near-payment');
  });
});

describe('buyFromProvider', () => {
  const provider: GuardProvider = {
    accountId: KEV,
    label: 'kev',
    endpoint: 'https://providers.test/near/v1/kev',
    description: '',
    price: PRICE,
    codeHash: null,
    registeredAtMs: 1,
    blocked: false,
  };
  const url = 'https://providers.test/near/v1/kev/lookup?cve=CVE-2021-44228';
  const allow: Assessment = { receiver: KEV, verdict: 'allow', signals: [] };
  const payment: GuardPayResult = {
    hash: 'Tx',
    success: true,
    failure: null,
    logs: [],
    receiptId: 9,
  };

  function deps(over: Partial<BuyDeps> & { quote?: Record<string, unknown> } = {}) {
    const { quotes } = book({ ms: Date.parse('2026-11-12T00:00:00Z') });
    const issued = quoteJson(quotes.issue('/x', KEV, PRICE));
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const paid: unknown[] = [];
    const d: BuyDeps = {
      network: 'near:testnet',
      guardContractId: GUARD,
      now: () => Date.parse('2026-11-12T00:00:01Z'),
      get: async (u, headers) => {
        calls.push({ url: u, headers: { ...headers } });
        return NEAR_PAYMENT_HEADER in headers
          ? { status: 200, body: { items: [1] } }
          : { status: 402, body: { accepts: [{ ...issued, ...over.quote }] } };
      },
      check: async () => allow,
      askHuman: async () => false,
      pay: async (r) => {
        paid.push(r);
        return payment;
      },
      ...over,
    };
    return { d, calls, paid, nonce: issued['nonce'] };
  }
  const request = { runId: 'run-1', provider, url, maxAmount: PRICE };

  it('gets a quote, pays through the guard with the nonce as memo, and returns the data', async () => {
    const { d, calls, paid, nonce } = deps();
    const out = await buyFromProvider(d, request);
    assert.equal(out.outcome, 'bought');
    assert.deepEqual(out.outcome === 'bought' ? out.data : null, { items: [1] });
    assert.deepEqual(paid, [{ runId: 'run-1', receiver: KEV, amount: PRICE, memo: nonce }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.headers[NEAR_PAYMENT_HEADER], `${nonce}:9`);
  });

  it('pays nothing when the quote does not match the registry', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ payTo: 'evil.testnet' }, /not the registered provider/],
      [{ guard: 'other.testnet' }, /another guard/],
      [{ network: 'near:mainnet' }, /near:mainnet/],
      [{ amount: (PRICE + 1n).toString() }, /above the registered price/],
      [{ expiresAt: '2026-11-11T00:00:00Z' }, /expired/],
    ];
    for (const [quote, reason] of cases) {
      const { d, paid } = deps({ quote });
      const out = await buyFromProvider(d, request);
      assert.equal(out.outcome, 'not-paid');
      assert.match(out.outcome === 'not-paid' ? out.reason : '', reason);
      assert.equal(paid.length, 0);
    }
  });

  it('pays nothing above the planned amount, outside the endpoint, or without a quote', async () => {
    const a = deps();
    const cheap = await buyFromProvider(a.d, { ...request, maxAmount: PRICE - 1n });
    assert.match(cheap.outcome === 'not-paid' ? cheap.reason : '', /planned to pay/);
    const elsewhere = await buyFromProvider(a.d, { ...request, url: 'https://evil.test/x' });
    assert.match(elsewhere.outcome === 'not-paid' ? elsewhere.reason : '', /registered endpoint/);
    const b = deps({ get: async () => ({ status: 200, body: {} }) });
    const free = await buyFromProvider(b.d, request);
    assert.match(free.outcome === 'not-paid' ? free.reason : '', /expected HTTP 402/);
    assert.equal(a.paid.length + b.paid.length, 0);
  });

  it('pays nothing when the counterparty check blocks', async () => {
    const { d, paid } = deps({ check: async () => ({ ...allow, verdict: 'block' }) });
    const out = await buyFromProvider(d, request);
    assert.equal(out.outcome, 'not-paid');
    assert.equal(paid.length, 0);
  });

  it('reports a contract refusal and a provider that does not deliver', async () => {
    const refused = deps({
      pay: async () => ({
        ...payment,
        success: false,
        failure: 'ERR_OVER_DAY_CAP',
        receiptId: null,
      }),
    });
    const r = await buyFromProvider(refused.d, request);
    assert.equal(r.outcome, 'rejected');
    assert.equal(r.outcome === 'rejected' ? r.reason : '', 'ERR_OVER_DAY_CAP');

    const { quotes } = book({ ms: Date.parse('2026-11-12T00:00:00Z') });
    const issued = quoteJson(quotes.issue('/x', KEV, PRICE));
    const silent = deps({
      get: async (_u, headers) =>
        NEAR_PAYMENT_HEADER in headers
          ? { status: 502, body: {} }
          : { status: 402, body: { accepts: [issued] } },
    });
    const s = await buyFromProvider(silent.d, request);
    assert.equal(s.outcome, 'paid-not-delivered');
    assert.equal(s.outcome === 'paid-not-delivered' ? s.receiptId : -1, 9);
  });
});

describe('setup actions', () => {
  it('serialises CreateAccount, DeployContract and AddKey', () => {
    const pair = generateKeyPair();
    const signer = signerFromSecretKey(pair.secretKey);
    assert.equal(signer.publicKey, pair.publicKey);
    const base = {
      signerId: 'owner.testnet',
      publicKey: signer.publicKeyBytes,
      nonce: 1n,
      receiverId: 'agent.owner.testnet',
      blockHash: base58Encode(new Uint8Array(32)),
    };
    const head = hex(encodeTransaction({ ...base, actions: [] })).length;
    const tail = (actions: Parameters<typeof encodeTransaction>[0]['actions']) =>
      hex(encodeTransaction({ ...base, actions })).slice(head);
    const pub = hex(signer.publicKeyBytes);
    assert.equal(tail([{ kind: 'createAccount' }]), '00');
    assert.equal(
      tail([{ kind: 'deployContract', code: Uint8Array.of(0, 0x61, 0x73, 0x6d) }]),
      '01' + '04000000' + '0061736d',
    );
    assert.equal(
      tail([
        { kind: 'addKey', publicKey: signer.publicKeyBytes, permission: { kind: 'fullAccess' } },
      ]),
      '05' + '00' + pub + '00'.repeat(8) + '01',
    );
    assert.equal(
      tail([
        {
          kind: 'addKey',
          publicKey: signer.publicKeyBytes,
          permission: {
            kind: 'functionCall',
            receiverId: 'g.testnet',
            methodNames: ['pay', 'attest'],
            allowance: 1n,
          },
        },
      ]),
      '05' +
        '00' +
        pub +
        '00'.repeat(8) +
        '00' + // FunctionCall permission
        '01' +
        '01' +
        '00'.repeat(15) + // allowance: Some(1)
        '09000000' +
        hex(new TextEncoder().encode('g.testnet')) +
        '02000000' +
        '03000000' +
        hex(new TextEncoder().encode('pay')) +
        '06000000' +
        hex(new TextEncoder().encode('attest')),
    );
  });
});
