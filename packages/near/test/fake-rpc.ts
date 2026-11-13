/** A scripted NEAR RPC for tests: accounts, keys, a guard contract's views, and send_tx results. */
import type { FetchLike } from '../src/index.ts';

export interface FakeChain {
  accounts: Record<string, { amount: string; code_hash: string }>;
  keys: Record<string, { public_key: string; nonce: number; permission: unknown }[]>;
  /** Guard view results by method name; a function gets the call's arguments. */
  views: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
  height: number;
  /** The result object `send_tx` returns, or an RPC error object. */
  sendResult: { result?: unknown; error?: unknown };
  /** Every request made, for assertions. */
  calls: { method: string; params: Record<string, unknown> }[];
}

export const NO_CONTRACT = '11111111111111111111111111111111';

export function fakeChain(overrides: Partial<FakeChain> = {}): FakeChain {
  return {
    accounts: {},
    keys: {},
    views: {},
    height: 200_000_000,
    sendResult: { result: {} },
    calls: [],
    ...overrides,
  };
}

function rpcError(name: string, info: unknown = {}) {
  return { error: { name: 'HANDLER_ERROR', cause: { name, info }, code: -32000, message: 'x' } };
}

export function fakeFetch(chain: FakeChain): FetchLike {
  return async (_url, init) => {
    const req = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    chain.calls.push({ method: req.method, params: req.params });
    const answer = (body: object) => ({
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    });
    if (req.method === 'block')
      return answer({
        result: {
          header: {
            height: chain.height,
            hash: NO_CONTRACT,
            timestamp_nanosec: '1794000000000000000',
          },
        },
      });
    if (req.method === 'send_tx') return answer(chain.sendResult);
    const p = req.params;
    const id = String(p['account_id']);
    if (p['request_type'] === 'view_account') {
      const a = chain.accounts[id];
      return answer(
        a === undefined
          ? rpcError('UNKNOWN_ACCOUNT')
          : { result: { ...a, locked: '0', storage_usage: 182 } },
      );
    }
    if (p['request_type'] === 'view_access_key_list')
      return answer({
        result: {
          keys: (chain.keys[id] ?? []).map((k) => ({
            public_key: k.public_key,
            access_key: { nonce: k.nonce, permission: k.permission },
          })),
        },
      });
    if (p['request_type'] === 'view_access_key') {
      const k = (chain.keys[id] ?? []).find((x) => x.public_key === p['public_key']);
      return answer(
        k === undefined
          ? rpcError('UNKNOWN_ACCESS_KEY')
          : { result: { nonce: k.nonce, permission: k.permission, block_hash: NO_CONTRACT } },
      );
    }
    if (p['request_type'] === 'call_function') {
      const view = chain.views[String(p['method_name'])];
      if (view === undefined) return answer(rpcError('CONTRACT_EXECUTION_ERROR'));
      const args = JSON.parse(
        Buffer.from(String(p['args_base64']), 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      const value = typeof view === 'function' ? (view as (a: typeof args) => unknown)(args) : view;
      return answer({ result: { result: [...Buffer.from(JSON.stringify(value))], logs: [] } });
    }
    return answer(rpcError('UNKNOWN_METHOD'));
  };
}
