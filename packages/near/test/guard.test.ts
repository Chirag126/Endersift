import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GuardAgent,
  GuardKeyError,
  GuardReader,
  NearRpc,
  NearRpcError,
  base58Encode,
  describeFailure,
  parseNear,
  signerFromSecretKey,
} from '../src/index.ts';
import { NO_CONTRACT, fakeChain, fakeFetch, type FakeChain } from './fake-rpc.ts';

const SEED = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const signer = signerFromSecretKey(`ed25519:${base58Encode(SEED)}`);
const GUARD = 'guard.endersift.testnet';
const AGENT = 'agent.endersift.testnet';
const KEV = 'kev.endersift.testnet';

const scopedKey = {
  public_key: signer.publicKey,
  nonce: 150_000_000_000_007,
  permission: {
    FunctionCall: { allowance: '250000000000000000000000', receiver_id: GUARD, method_names: [] },
  },
};

const provider = {
  label: 'kev',
  endpoint: 'https://endersift-providers.onrender.com/v1/kev',
  description: 'CISA KEV',
  price: parseNear('0.002').toString(),
  code_hash: '',
  registered_at_ms: 1_794_000_000_000,
};

function setup(overrides: Partial<FakeChain> = {}) {
  const chain = fakeChain({
    accounts: { [AGENT]: { amount: '1', code_hash: NO_CONTRACT } },
    keys: { [AGENT]: [scopedKey] },
    views: {
      get_provider: (a: Record<string, unknown>) => (a['account_id'] === KEV ? provider : null),
      get_reports: [],
      get_providers: [{ account_id: KEV, provider, blocked: false }],
    },
    ...overrides,
  });
  const rpc = new NearRpc({ url: 'https://rpc.test', fetch: fakeFetch(chain) });
  const agent = new GuardAgent({ rpc, contractId: GUARD, accountId: AGENT, signer });
  return { chain, rpc, agent, reader: new GuardReader(rpc, GUARD) };
}

const paid = (value: number) => ({
  result: {
    status: { SuccessValue: Buffer.from(String(value)).toString('base64') },
    transaction: { hash: 'TxHash111' },
    receipts_outcome: [{ outcome: { logs: ['EVENT_JSON:{"event":"payment_sent"}'], status: {} } }],
  },
});

const refused = (code: string) => ({
  result: {
    status: {
      Failure: {
        ActionError: {
          index: 0,
          kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${code}` } },
        },
      },
    },
    transaction: { hash: 'TxHash222' },
    receipts_outcome: [],
  },
});

describe('GuardReader', () => {
  it('reads the registry and checks every field', async () => {
    const { reader } = setup();
    const [p] = await reader.providers();
    assert.equal(p?.accountId, KEV);
    assert.equal(p?.price, parseNear('0.002'));
    assert.equal(p?.codeHash, null);
    assert.equal(p?.blocked, false);
    assert.equal(await reader.provider('nobody.testnet'), null);
  });

  it('rejects a malformed registry entry instead of trusting it', async () => {
    const { reader } = setup({
      views: { get_providers: [{ account_id: 'NOT VALID', provider, blocked: false }] },
    });
    await assert.rejects(reader.providers(), NearRpcError);
    const { reader: second } = setup({
      views: {
        get_providers: [{ account_id: KEV, provider: { ...provider, price: 5 }, blocked: false }],
      },
    });
    await assert.rejects(second.providers());
  });

  it('strips control characters from on-chain text', async () => {
    const { reader } = setup({
      views: {
        get_provider: { ...provider, description: 'line\u0000one\nline two' },
        get_reports: [],
      },
    });
    assert.equal((await reader.provider(KEV))?.description, 'line one line two');
  });
});

describe('GuardAgent', () => {
  it('pays through the guard and returns the receipt id', async () => {
    const { chain, agent } = setup({ sendResult: paid(7) });
    const result = await agent.pay({
      runId: 'run-1',
      receiver: KEV,
      amount: parseNear('0.002'),
      memo: 'kev lookup',
    });
    assert.equal(result.success, true);
    assert.equal(result.receiptId, 7);
    assert.equal(result.hash, 'TxHash111');
    assert.equal(result.logs.length, 1);
    const sent = chain.calls.find((c) => c.method === 'send_tx');
    assert.equal(sent?.params['wait_until'], 'EXECUTED_OPTIMISTIC');
    // the signed bytes call `pay` on the guard, with no deposit and no transfer action
    const raw = Buffer.from(String(sent?.params['signed_tx_base64']), 'base64');
    assert.ok(raw.includes(Buffer.from(GUARD)));
    assert.ok(raw.includes(Buffer.from('"receiver":"kev.endersift.testnet"')));
  });

  it("reports the contract's refusal code", async () => {
    const { agent } = setup({ sendResult: refused('ERR_BLOCKED') });
    const result = await agent.pay({ runId: 'r', receiver: KEV, amount: 1n, memo: '' });
    assert.equal(result.success, false);
    assert.equal(result.failure, 'ERR_BLOCKED');
    assert.equal(result.receiptId, null);
  });

  it('refuses to sign with a full-access key', async () => {
    const { chain, agent } = setup({
      keys: { [AGENT]: [{ ...scopedKey, permission: 'FullAccess' }] },
    });
    await assert.rejects(
      agent.pay({ runId: 'r', receiver: KEV, amount: 1n, memo: '' }),
      (e: unknown) => e instanceof GuardKeyError && e.code === 'FULL_ACCESS_KEY',
    );
    assert.equal(chain.calls.filter((c) => c.method === 'send_tx').length, 0);
  });

  it('refuses a key scoped to another contract, and a key that is not on the account', async () => {
    const other = setup({
      keys: {
        [AGENT]: [
          {
            ...scopedKey,
            permission: {
              FunctionCall: { allowance: null, receiver_id: 'other.testnet', method_names: [] },
            },
          },
        ],
      },
    });
    await assert.rejects(
      other.agent.attest(1, true),
      (e: unknown) => e instanceof GuardKeyError && e.code === 'KEY_FOR_ANOTHER_CONTRACT',
    );
    const none = setup({ keys: {} });
    await assert.rejects(
      none.agent.report(KEV, 'x', 'y'),
      (e: unknown) => e instanceof GuardKeyError && e.code === 'KEY_NOT_ON_ACCOUNT',
    );
    assert.equal(other.chain.calls.filter((c) => c.method === 'send_tx').length, 0);
    assert.equal(none.chain.calls.filter((c) => c.method === 'send_tx').length, 0);
  });

  it('uses the next nonce for each transaction, one at a time', async () => {
    const { chain, agent } = setup({ sendResult: paid(1) });
    await Promise.all([agent.attest(1, true), agent.attest(2, false)]);
    const order = chain.calls.map((c) =>
      c.method === 'send_tx' ? 'send' : String(c.params['request_type']),
    );
    assert.deepEqual(order, ['view_access_key', 'send', 'view_access_key', 'send']);
  });

  it('surfaces an invalid transaction as an RPC error with its cause', async () => {
    const { agent } = setup({
      sendResult: {
        error: {
          name: 'HANDLER_ERROR',
          cause: { name: 'INVALID_TRANSACTION' },
          data: {
            TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: 'RequiresFullAccess' } },
          },
        },
      },
    });
    await assert.rejects(
      agent.pay({ runId: 'r', receiver: KEV, amount: 1n, memo: '' }),
      (e: unknown) =>
        e instanceof NearRpcError &&
        e.code === 'INVALID_TRANSACTION' &&
        /RequiresFullAccess/.test(e.message),
    );
  });
});

describe('describeFailure', () => {
  it('prefers the contract code, and never returns raw control characters', () => {
    assert.equal(
      describeFailure({ x: 'Smart contract panicked: ERR_OVER_DAY_CAP' }),
      'ERR_OVER_DAY_CAP',
    );
    assert.ok(!/\n/.test(describeFailure('a\nb')));
    assert.ok(describeFailure('x'.repeat(5000)).length <= 200);
  });
});
