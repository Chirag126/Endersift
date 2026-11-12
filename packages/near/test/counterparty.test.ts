import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GuardReader,
  NearRpc,
  assess,
  checkCounterparty,
  guardedPay,
  keyHeight,
  keyTransactions,
  parseNear,
  type Assessment,
  type CounterpartyFacts,
  type GuardPayResult,
} from '../src/index.ts';
import { NO_CONTRACT, fakeChain, fakeFetch } from './fake-rpc.ts';

const KEV = 'kev.endersift.testnet';
const PRICE = parseNear('0.002');

const provider = {
  accountId: KEV,
  label: 'kev',
  endpoint: 'https://example.test/v1/kev',
  description: '',
  price: PRICE,
  codeHash: null,
  registeredAtMs: 1,
  blocked: false,
};

const good: CounterpartyFacts = {
  receiver: KEV,
  amount: PRICE,
  exists: true,
  codeHash: null,
  keyCount: 1,
  oldestKeyHeight: 100_000_000,
  signedTransactions: 12,
  headHeight: 200_000_000,
  provider,
  reports: [],
  stats: { payments: 3, total: PRICE * 3n, passed: 3, failed: 0, firstPaidAtMs: 5 },
};

const codes = (a: Assessment, level: string) =>
  a.signals.filter((s) => s.level === level).map((s) => s.code);

describe('assess', () => {
  it('allows a registered, established receiver with a clean history', () => {
    const a = assess(good);
    assert.equal(a.verdict, 'allow');
    assert.deepEqual(codes(a, 'allow'), ['ACCOUNT_AGE', 'PAID_BEFORE']);
  });

  it('blocks a receiver on the blocklist and quotes the evidence', () => {
    const a = assess({
      ...good,
      reports: [
        { reporter: 'agent.testnet', reason: 'forged data', evidence: 'receipt 7', atMs: 1 },
      ],
    });
    assert.equal(a.verdict, 'block');
    const signal = a.signals.find((s) => s.code === 'BLOCKLISTED');
    assert.match(signal?.detail ?? '', /forged data.*receipt 7/);
  });

  it('blocks an unregistered receiver, a missing account and an amount above the price', () => {
    assert.deepEqual(codes(assess({ ...good, provider: null }), 'block'), ['NOT_REGISTERED']);
    assert.deepEqual(
      codes(assess({ ...good, exists: false, provider: null, oldestKeyHeight: null }), 'block'),
      ['NO_ACCOUNT', 'NOT_REGISTERED'],
    );
    assert.deepEqual(codes(assess({ ...good, amount: PRICE + 1n }), 'block'), ['ABOVE_PRICE']);
  });

  it('warns when the contract code changed since registration', () => {
    assert.deepEqual(codes(assess({ ...good, codeHash: 'NewHash' }), 'warn'), ['CODE_CHANGED']);
    const pinned = { ...good, provider: { ...provider, codeHash: 'OldHash' } };
    assert.deepEqual(codes(assess({ ...pinned, codeHash: 'NewHash' }), 'warn'), ['CODE_CHANGED']);
    assert.deepEqual(codes(assess({ ...pinned, codeHash: null }), 'warn'), ['CODE_CHANGED']);
    assert.equal(assess({ ...pinned, codeHash: 'OldHash' }).verdict, 'allow');
  });

  it('warns about a young account until its work has passed a check', () => {
    const young = { ...good, oldestKeyHeight: good.headHeight - 100 };
    const fresh = {
      ...young,
      stats: { payments: 0, total: 0n, passed: 0, failed: 0, firstPaidAtMs: 0 },
    };
    assert.equal(assess(fresh).verdict, 'warn');
    assert.deepEqual(codes(assess(fresh), 'warn'), ['YOUNG_ACCOUNT']);
    assert.equal(assess(young).verdict, 'allow');
    assert.equal(assess(fresh, { minAgeBlocks: 50 }).verdict, 'allow');
  });

  it('warns when past work failed at least as often as it passed', () => {
    const a = assess({ ...good, stats: { ...good.stats, passed: 1, failed: 1 } });
    assert.deepEqual(codes(a, 'warn'), ['FAILED_BEFORE']);
  });

  it('a block outranks a warning', () => {
    const a = assess({ ...good, codeHash: 'NewHash', provider: null });
    assert.equal(a.verdict, 'block');
  });

  it('reads a key nonce as height and transaction count', () => {
    assert.equal(keyHeight(150_000_000_000_007n), 150_000_000);
    assert.equal(keyTransactions(150_000_000_000_007n), 7);
  });
});

describe('checkCounterparty', () => {
  it('collects every fact from the RPC and the guard contract', async () => {
    const chain = fakeChain({
      accounts: { [KEV]: { amount: '5', code_hash: NO_CONTRACT } },
      keys: {
        [KEV]: [
          { public_key: 'ed25519:a', nonce: 150_000_000_000_004, permission: 'FullAccess' },
          { public_key: 'ed25519:b', nonce: 120_000_000_000_001, permission: 'FullAccess' },
        ],
      },
      views: {
        get_provider: {
          label: 'kev',
          endpoint: 'https://example.test/v1/kev',
          description: '',
          price: PRICE.toString(),
          code_hash: '',
          registered_at_ms: 1,
        },
        get_reports: [],
        get_receiver_stats: {
          payments: 2,
          total: (PRICE * 2n).toString(),
          passed: 2,
          failed: 0,
          first_paid_at_ms: 9,
        },
      },
    });
    const rpc = new NearRpc({ url: 'https://rpc.test', fetch: fakeFetch(chain) });
    const a = await checkCounterparty(rpc, new GuardReader(rpc, 'guard.testnet'), KEV, PRICE);
    assert.equal(a.verdict, 'allow');
    const age = a.signals.find((s) => s.code === 'ACCOUNT_AGE');
    assert.match(age?.detail ?? '', /about 80000000 blocks and signed 5 transaction/);
  });

  it('blocks an account that does not exist', async () => {
    const chain = fakeChain({
      views: {
        get_provider: null,
        get_reports: [],
        get_receiver_stats: { payments: 0, total: '0', passed: 0, failed: 0, first_paid_at_ms: 0 },
      },
    });
    const rpc = new NearRpc({ url: 'https://rpc.test', fetch: fakeFetch(chain) });
    const a = await checkCounterparty(
      rpc,
      new GuardReader(rpc, 'guard.testnet'),
      'evil.testnet',
      1n,
    );
    assert.equal(a.verdict, 'block');
    assert.deepEqual(codes(a, 'block'), ['NO_ACCOUNT', 'NOT_REGISTERED']);
  });
});

describe('guardedPay', () => {
  const request = { runId: 'run-1', receiver: KEV, amount: PRICE, memo: 'kev' };
  const payment: GuardPayResult = {
    hash: 'Tx',
    success: true,
    failure: null,
    logs: [],
    receiptId: 3,
  };
  const verdict = (v: Assessment['verdict']): Assessment => ({
    receiver: KEV,
    verdict: v,
    signals: [],
  });

  it('never signs when the answer is block', async () => {
    let signed = 0;
    let asked = 0;
    const out = await guardedPay(
      {
        check: async () => verdict('block'),
        askHuman: async () => {
          asked += 1;
          return true;
        },
        pay: async () => {
          signed += 1;
          return payment;
        },
      },
      request,
    );
    assert.equal(out.outcome, 'refused');
    assert.equal(signed, 0);
    assert.equal(asked, 0);
  });

  it('asks a human on warn and signs only on yes', async () => {
    let signed = 0;
    const deps = (answer: boolean) => ({
      check: async () => verdict('warn'),
      askHuman: async () => answer,
      pay: async () => {
        signed += 1;
        return payment;
      },
    });
    assert.equal((await guardedPay(deps(false), request)).outcome, 'declined');
    assert.equal(signed, 0);
    const yes = await guardedPay(deps(true), request);
    assert.equal(yes.outcome, 'paid');
    assert.equal(yes.outcome === 'paid' && yes.approvedByHuman, true);
    assert.equal(signed, 1);
  });

  it('signs on allow without asking, and reports a contract refusal as rejected', async () => {
    let asked = 0;
    const out = await guardedPay(
      {
        check: async () => verdict('allow'),
        askHuman: async () => {
          asked += 1;
          return false;
        },
        pay: async () => ({
          ...payment,
          success: false,
          failure: 'ERR_OVER_RUN_CAP',
          receiptId: null,
        }),
      },
      request,
    );
    assert.equal(out.outcome, 'rejected');
    assert.equal(asked, 0);
  });
});
