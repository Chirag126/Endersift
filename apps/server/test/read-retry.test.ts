// Class: unit. Bounded retry of read-only chain calls on a provider rate limit
// (D-054), and redaction of RPC keys carried in URL paths.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REDACTED, redactText } from '../src/api/redact.ts';
import { isRateLimited, retryReadOnRateLimit } from '../src/read-retry.ts';

// built by concatenation so the source never contains a key-shaped URL
const KEY = 'alch_' + 'E6eoMa0vxJtJsElink'.toLowerCase();
const ALCHEMY = 'https://eth-sepolia.g.alchemy.com/v2/' + KEY;

describe('read retry', () => {
  it('recognises rate-limit answers, and only those', () => {
    assert.ok(
      isRateLimited(new Error('Your app has exceeded its compute units per second capacity')),
    );
    assert.ok(isRateLimited(new Error('HTTP request failed. Status: 429')));
    assert.ok(isRateLimited(new Error('limit exceeded (-32005)')));
    assert.ok(!isRateLimited(new Error('execution reverted')));
    assert.ok(!isRateLimited(new Error('ETH_RPC_URL is not Sepolia')));
  });

  it('retries a rate-limited read with doubling delays, then succeeds', async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await retryReadOnRateLimit(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('exceeded its compute units per second capacity');
        return 'snapshot';
      },
      { sleep: async (ms) => void delays.push(ms), baseDelayMs: 100 },
    );
    assert.equal(value, 'snapshot');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it('gives up after the last attempt, and never retries other errors', async () => {
    let calls = 0;
    await assert.rejects(
      retryReadOnRateLimit(
        async () => {
          calls += 1;
          throw new Error('429 Too Many Requests');
        },
        { attempts: 3, sleep: async () => {} },
      ),
      /429/,
    );
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(
      retryReadOnRateLimit(
        async () => {
          calls += 1;
          throw new Error('execution reverted');
        },
        { sleep: async () => {} },
      ),
      /reverted/,
    );
    assert.equal(calls, 1);
  });
});

describe('RPC keys in URL paths are redacted', () => {
  it('Alchemy, Infura and other hosted endpoints', () => {
    const viemError = `RpcRequestError: RPC Request failed.\n\nURL: ${ALCHEMY}\nRequest body: {}`;
    const out = redactText(viemError);
    assert.ok(!out.includes(KEY), out);
    assert.match(out, new RegExp(`alchemy\\.com/v2/\\${REDACTED.replace(']', '\\]')}`));
    const infuraKey = 'ab'.repeat(16);
    assert.ok(!redactText('https://sepolia.infura.io/v3/' + infuraKey).includes(infuraKey));
    const qn = 'https://black-bird.ethereum-sepolia.quiknode.pro/' + 'cd'.repeat(16) + '/';
    assert.equal(redactText(qn), `https://black-bird.ethereum-sepolia.quiknode.pro/${REDACTED}`);
    // a provider endpoint we pay stays readable
    const provider = 'https://kev.example.com/v1/kev/recent?since=2026-10-20&limit=5';
    assert.equal(redactText(provider), provider);
  });
});
