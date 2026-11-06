// Class: unit. Sepolia writes under RPC rate limits (D-067): retried only on a
// rate limit, always with the same nonce, so a step can never run twice.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AmbiguousSendError, isRateLimit, writeWithFixedNonce } from '../lib/rpc-write.ts';

const limited = () =>
  Object.assign(new Error('HTTP request failed.\n\nStatus: 429'), { status: 429 });
const noSleep = async () => {};

describe('rpc writes under rate limits (D-067)', () => {
  it('recognises rate limits, also when wrapped', () => {
    assert.equal(isRateLimit(limited()), true);
    assert.equal(isRateLimit(new Error('outer', { cause: new Error('Too Many Requests') })), true);
    assert.equal(
      isRateLimit(new Error('Your app has exceeded its compute units per second')),
      true,
    );
    assert.equal(isRateLimit(new Error('execution reverted: TransferDisallowed')), false);
    assert.equal(isRateLimit(null), false);
  });

  it('retries a rate limit with the same nonce, read once', async () => {
    const nonces: number[] = [];
    let reads = 0;
    const hash = await writeWithFixedNonce({
      nonce: async () => (++reads, 7),
      write: async (n) => {
        nonces.push(n);
        if (nonces.length < 3) throw limited();
        return '0xabc';
      },
      sleep: noSleep,
    });
    assert.equal(hash, '0xabc');
    assert.deepEqual(nonces, [7, 7, 7]);
    assert.equal(reads, 1);
  });

  it('other errors are thrown at once; after a rate limit they are ambiguous', async () => {
    let calls = 0;
    await assert.rejects(
      writeWithFixedNonce({
        nonce: async () => 1,
        write: async () => {
          calls++;
          throw new Error('execution reverted');
        },
        sleep: noSleep,
      }),
      /execution reverted/,
    );
    assert.equal(calls, 1);
    let n = 0;
    await assert.rejects(
      writeWithFixedNonce({
        nonce: async () => 1,
        write: async () => {
          if (n++ === 0) throw limited();
          throw new Error('nonce too low');
        },
        sleep: noSleep,
      }),
      AmbiguousSendError,
    );
  });

  it('gives up after the last delay, saying to check Etherscan', async () => {
    await assert.rejects(
      writeWithFixedNonce({
        nonce: async () => 3,
        write: async () => {
          throw limited();
        },
        delaysMs: [1, 1],
        sleep: noSleep,
      }),
      /still rate-limited after 3 attempts with nonce 3/,
    );
  });
});
