// Class: mock. Uses an injected fake fetch with hand-written fixtures shaped like
// Mirror Node /api/v1/accounts/{id} responses. Never sponsor evidence.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FetchLike } from '../src/http.ts';
import { HttpJsonError } from '../src/http.ts';
import {
  MirrorNodeClient,
  MirrorNodeError,
  hashscanAccountUrl,
  hashscanTransactionUrl,
  parseMirrorAccount,
  parseMirrorTransaction,
} from '../src/mirror.ts';

const FIXTURE = {
  account: '0.0.4815162',
  balance: { balance: 1_234_500_000_000, timestamp: '1730000000.000000000', tokens: [] },
  deleted: false,
  evm_address: '0x00000000000000000000000000000000004979ba',
  key: { _type: 'ECDSA_SECP256K1', key: '02ABCDEF' + '0'.repeat(58) },
  max_automatic_token_associations: -1,
  memo: 'agent-economy provider kev',
};

function fakeFetch(status: number, body: unknown, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
}

describe('parseMirrorAccount', () => {
  it('parses the fields we rely on, lower-casing the key', () => {
    const a = parseMirrorAccount(FIXTURE);
    assert.equal(a.accountId, '0.0.4815162');
    assert.equal(a.balanceTinybars, 1_234_500_000_000n);
    assert.equal(a.keyType, 'ECDSA_SECP256K1');
    assert.equal(a.publicKey, '02abcdef' + '0'.repeat(58));
    assert.equal(a.maxAutomaticTokenAssociations, -1);
    assert.equal(a.deleted, false);
  });

  it('treats complex (protobuf-encoded) keys as having no single public key', () => {
    const a = parseMirrorAccount({ ...FIXTURE, key: { _type: 'ProtobufEncoded', key: 'abcd' } });
    assert.equal(a.publicKey, null);
    assert.equal(a.keyType, 'ProtobufEncoded');
  });

  it('rejects malformed responses instead of defaulting', () => {
    assert.throws(() => parseMirrorAccount(null), MirrorNodeError);
    assert.throws(() => parseMirrorAccount({ ...FIXTURE, account: 'nope' }), MirrorNodeError);
    assert.throws(
      () => parseMirrorAccount({ ...FIXTURE, balance: { balance: '12' } }),
      MirrorNodeError,
    );
    assert.throws(
      () => parseMirrorAccount({ ...FIXTURE, balance: { balance: -1 } }),
      MirrorNodeError,
    );
  });
});

describe('MirrorNodeClient', () => {
  it('requests /api/v1/accounts/{id} and validates the returned id', async () => {
    const calls: string[] = [];
    const client = new MirrorNodeClient('https://testnet.mirrornode.hedera.com/', {
      fetch: fakeFetch(200, FIXTURE, calls),
    });
    const a = await client.getAccount('0.0.4815162');
    assert.equal(a.accountId, '0.0.4815162');
    assert.deepEqual(calls, ['https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.4815162']);
  });

  it('rejects a response for a different account', async () => {
    const client = new MirrorNodeClient('https://m.example', { fetch: fakeFetch(200, FIXTURE) });
    await assert.rejects(client.getAccount('0.0.1'), /returned 0\.0\.4815162 for 0\.0\.1/);
  });

  it('rejects invalid ids before making a request', async () => {
    const calls: string[] = [];
    const client = new MirrorNodeClient('https://m.example', {
      fetch: fakeFetch(200, FIXTURE, calls),
    });
    await assert.rejects(client.getAccount('0x123'), MirrorNodeError);
    assert.equal(calls.length, 0);
  });

  it('surfaces HTTP errors, non-JSON and oversize bodies as HttpJsonError', async () => {
    const notFound = new MirrorNodeClient('https://m.example', {
      fetch: fakeFetch(404, { _status: {} }),
    });
    await assert.rejects(
      notFound.getAccount('0.0.1'),
      (e: unknown) => e instanceof HttpJsonError && e.status === 404,
    );

    const html = new MirrorNodeClient('https://m.example', { fetch: fakeFetch(200, '<html>') });
    await assert.rejects(html.getAccount('0.0.1'), /not valid JSON/);

    const huge = new MirrorNodeClient('https://m.example', {
      fetch: fakeFetch(200, 'x'.repeat(2000)),
      maxBytes: 1000,
    });
    await assert.rejects(huge.getAccount('0.0.1'), /exceeds 1000 bytes/);
  });

  it('refuses plain-http base URLs', async () => {
    const client = new MirrorNodeClient('http://m.example', { fetch: fakeFetch(200, FIXTURE) });
    await assert.rejects(client.getAccount('0.0.4815162'), /non-https/);
  });
});

describe('HashScan links', () => {
  it('builds account and URL-encoded transaction links', () => {
    assert.equal(
      hashscanAccountUrl('testnet', '0.0.5'),
      'https://hashscan.io/testnet/account/0.0.5',
    );
    assert.equal(
      hashscanTransactionUrl('testnet', '0.0.5@1700000000.000000001'),
      'https://hashscan.io/testnet/transaction/0.0.5%401700000000.000000001',
    );
  });
});

const TX_FIXTURE = {
  transactions: [
    {
      transaction_id: '0.0.7162784-1730000000-123456789',
      result: 'SUCCESS',
      name: 'CRYPTOTRANSFER',
      consensus_timestamp: '1730000002.000000001',
      charged_tx_fee: 84000,
      transfers: [
        { account: '0.0.11044318', amount: -100000, is_approval: false },
        { account: '0.0.11044329', amount: 100000, is_approval: false },
      ],
    },
  ],
};

describe('parseMirrorTransaction', () => {
  it('parses id, result, fee and signed transfers as bigint', () => {
    const tx = parseMirrorTransaction(TX_FIXTURE);
    assert.equal(tx.transactionId, '0.0.7162784-1730000000-123456789');
    assert.equal(tx.result, 'SUCCESS');
    assert.equal(tx.chargedTxFee, 84000n);
    assert.deepEqual(tx.transfers, [
      { account: '0.0.11044318', amount: -100000n },
      { account: '0.0.11044329', amount: 100000n },
    ]);
  });

  it('rejects malformed transaction responses', () => {
    assert.throws(() => parseMirrorTransaction({}), MirrorNodeError);
    assert.throws(() => parseMirrorTransaction({ transactions: [] }), /empty/);
    const bad = structuredClone(TX_FIXTURE);
    (bad.transactions[0] as { transfers: unknown }).transfers = [{ account: 1 }];
    assert.throws(() => parseMirrorTransaction(bad), /malformed/);
  });
});

describe('MirrorNodeClient transactions', () => {
  it('returns null while the Mirror Node has not ingested the transaction (404)', async () => {
    const client = new MirrorNodeClient('https://m.example', {
      fetch: fakeFetch(404, { _status: {} }),
    });
    assert.equal(await client.getTransaction('0.0.7162784-1730000000-123456789'), null);
  });

  it('polls until the transaction appears', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return calls < 3
        ? new Response('{"_status":{}}', { status: 404 })
        : new Response(JSON.stringify(TX_FIXTURE), { status: 200 });
    };
    const client = new MirrorNodeClient('https://m.example', { fetch: fetchImpl });
    const tx = await client.waitForTransaction('0.0.7162784-1730000000-123456789', {
      timeoutMs: 1000,
      intervalMs: 5,
    });
    assert.equal(tx?.result, 'SUCCESS');
    assert.equal(calls, 3);
  });

  it('gives up with null after the timeout, so callers treat the outcome as unknown', async () => {
    const client = new MirrorNodeClient('https://m.example', { fetch: fakeFetch(404, {}) });
    const tx = await client.waitForTransaction('0.0.7162784-1730000000-123456789', {
      timeoutMs: 20,
      intervalMs: 5,
    });
    assert.equal(tx, null);
  });

  it('rejects malformed transaction ids before any request', async () => {
    const calls: string[] = [];
    const client = new MirrorNodeClient('https://m.example', {
      fetch: fakeFetch(200, TX_FIXTURE, calls),
    });
    await assert.rejects(client.getTransaction('0.0.1@1.2'), MirrorNodeError);
    assert.equal(calls.length, 0);
  });
});

describe('MirrorNodeClient account transfers (D-062)', () => {
  const page = (ids: string[], next: string | null) => ({
    transactions: ids.map((id) => ({ ...TX_FIXTURE.transactions[0], transaction_id: id })),
    links: { next },
  });

  it('queries successful transfers in the window, oldest first, and follows relative next links', async () => {
    const calls: string[] = [];
    const pages = [
      page(
        ['0.0.7162784-1730000001-000000001'],
        '/api/v1/transactions?account.id=0.0.11044318&timestamp=gt:1730000001.000000001&limit=100&order=asc',
      ),
      page(['0.0.7162784-1730000002-000000001'], null),
    ];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(pages[calls.length - 1]), { status: 200 });
    };
    const client = new MirrorNodeClient('https://m.example', { fetch: fetchImpl });
    const txs = await client.listAccountTransfers('0.0.11044318', 1730000000, 1730086400);
    assert.deepEqual(
      txs.map((t) => t.transactionId),
      ['0.0.7162784-1730000001-000000001', '0.0.7162784-1730000002-000000001'],
    );
    const first = new URL(calls[0] ?? '');
    assert.equal(first.pathname, '/api/v1/transactions');
    assert.equal(first.searchParams.get('account.id'), '0.0.11044318');
    assert.equal(first.searchParams.get('result'), 'success');
    assert.equal(first.searchParams.get('transactiontype'), 'CRYPTOTRANSFER');
    assert.deepEqual(first.searchParams.getAll('timestamp'), [
      'gte:1730000000.000000000',
      'lt:1730086400.000000000',
    ]);
    assert.ok((calls[1] ?? '').startsWith('https://m.example/api/v1/transactions?'));
  });

  it('refuses a next link to anywhere else, and a list longer than maxPages', async () => {
    for (const next of ['https://evil.example/api/v1/transactions?x=1', '/api/v1/accounts?x=1']) {
      const client = new MirrorNodeClient('https://m.example', {
        fetch: fakeFetch(200, page([], next)),
      });
      await assert.rejects(client.listAccountTransfers('0.0.1', 0, 10), /links\.next/);
    }
    const endless = new MirrorNodeClient('https://m.example', {
      fetch: fakeFetch(200, page([], '/api/v1/transactions?p=2')),
    });
    await assert.rejects(
      endless.listAccountTransfers('0.0.1', 0, 10, { maxPages: 3 }),
      /refusing a partial list/,
    );
  });

  it('rejects a bad account or range before any request', async () => {
    const calls: string[] = [];
    const client = new MirrorNodeClient('https://m.example', { fetch: fakeFetch(200, {}, calls) });
    await assert.rejects(client.listAccountTransfers('0.0.x', 0, 10), /invalid account/);
    await assert.rejects(client.listAccountTransfers('0.0.1', -1, 10), /invalid time range/);
    assert.equal(calls.length, 0);
  });
});

describe('token transfers (HTS, D-064)', () => {
  const withTokens = (tokenTransfers: unknown) => ({
    transactions: [{ ...TX_FIXTURE.transactions[0], token_transfers: tokenTransfers }],
  });

  it('parses each token transfer with a signed bigint amount', () => {
    const tx = parseMirrorTransaction(
      withTokens([
        { token_id: '0.0.429274', account: '0.0.11044318', amount: -10000, is_approval: false },
        { token_id: '0.0.429274', account: '0.0.11044329', amount: 10000, is_approval: false },
      ]),
    );
    assert.equal(tx.tokenTransferCount, 2);
    assert.deepEqual(tx.tokenTransfers, [
      { tokenId: '0.0.429274', account: '0.0.11044318', amount: -10000n },
      { tokenId: '0.0.429274', account: '0.0.11044329', amount: 10000n },
    ]);
    assert.equal(parseMirrorTransaction(TX_FIXTURE).tokenTransfers, undefined);
  });

  it('rejects a malformed token transfer instead of skipping it', () => {
    for (const bad of [
      [{ token_id: 'usdc', account: '0.0.1', amount: 1 }],
      [{ token_id: '0.0.429274', account: '0.0.1', amount: '1' }],
      [{ token_id: '0.0.429274', account: '0.0.1', amount: 2 ** 60 }],
      ['x'],
    ])
      assert.throws(
        () => parseMirrorTransaction(withTokens(bad)),
        /token_transfers\[0\] is malformed/,
      );
  });
});
