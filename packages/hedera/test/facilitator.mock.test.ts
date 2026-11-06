// Class: mock. Fixtures follow the SupportedResponse type in @x402/core
// (typescript/packages/core/src/types/facilitator.ts). They are hand-written,
// not captured facilitator responses. Never sponsor evidence.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FetchLike } from '../src/http.ts';
import {
  DOCUMENTED_TESTNET_FACILITATORS,
  FacilitatorResponseError,
  fetchSupported,
  findHederaExactKind,
  parseSupportedResponse,
} from '../src/facilitator.ts';

const SUPPORTED = {
  kinds: [
    { x402Version: 1, scheme: 'exact', network: 'hedera:testnet', extra: { feePayer: '0.0.1111' } },
    {
      x402Version: 2,
      scheme: 'exact',
      network: 'hedera:testnet',
      extra: { feePayer: '0.0.7162784' },
    },
    { x402Version: 2, scheme: 'exact', network: 'eip155:84532' },
  ],
  extensions: [],
  signers: { 'hedera:*': ['0.0.7162784'] },
};

describe('parseSupportedResponse', () => {
  it('parses kinds, extensions and signers', () => {
    const s = parseSupportedResponse(SUPPORTED);
    assert.equal(s.kinds.length, 3);
    assert.deepEqual(s.signers['hedera:*'], ['0.0.7162784']);
  });

  it('tolerates missing optional fields', () => {
    const s = parseSupportedResponse({ kinds: [] });
    assert.deepEqual(s.extensions, []);
    assert.deepEqual(s.signers, {});
  });

  it('rejects malformed kinds', () => {
    assert.throws(() => parseSupportedResponse({}), FacilitatorResponseError);
    assert.throws(() => parseSupportedResponse({ kinds: [{ scheme: 'exact' }] }), /x402Version/);
    assert.throws(
      () =>
        parseSupportedResponse({
          kinds: [{ x402Version: 2, scheme: 'exact', network: 'x', extra: [] }],
        }),
      /extra is not an object/,
    );
  });
});

describe('findHederaExactKind', () => {
  it('prefers the newest x402 version and returns its fee payer', () => {
    const r = findHederaExactKind(parseSupportedResponse(SUPPORTED), 'hedera:testnet');
    assert.ok(r.ok);
    assert.equal(r.kind.x402Version, 2);
    assert.equal(r.feePayer, '0.0.7162784');
  });

  it('reports a missing network or missing/invalid fee payer', () => {
    const s = parseSupportedResponse(SUPPORTED);
    const mainnet = findHederaExactKind(s, 'hedera:mainnet');
    assert.equal(mainnet.ok, false);

    const noPayer = parseSupportedResponse({
      kinds: [
        {
          x402Version: 2,
          scheme: 'exact',
          network: 'hedera:testnet',
          extra: { feePayer: '0xabc' },
        },
      ],
    });
    const r = findHederaExactKind(noPayer, 'hedera:testnet');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /feePayer/);
  });
});

describe('fetchSupported', () => {
  it('calls {base}/supported once and keeps the raw body for evidence', async () => {
    const calls: string[] = [];
    const fakeFetch: FetchLike = async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(SUPPORTED), { status: 200 });
    };
    const r = await fetchSupported('https://x402.org/facilitator/', { fetch: fakeFetch });
    assert.deepEqual(calls, ['https://x402.org/facilitator/supported']);
    assert.equal(r.httpStatus, 200);
    assert.equal(JSON.parse(r.raw).kinds.length, 3);
  });
});

describe('documented facilitators', () => {
  it('lists the three Hedera-docs facilitators over https with fee payers', () => {
    assert.equal(DOCUMENTED_TESTNET_FACILITATORS.length, 3);
    for (const f of DOCUMENTED_TESTNET_FACILITATORS) {
      assert.ok(f.url.startsWith('https://'));
      assert.match(f.feePayer, /^0\.0\.\d+$/);
    }
  });
});
