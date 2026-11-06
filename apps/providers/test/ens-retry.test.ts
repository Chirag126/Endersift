// Class: unit. The providers' startup ENS read is tried again after a failure
// (D-082): a free Sepolia RPC answering 429 on a Render cold start no longer
// stops the process; the last failure still does.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENS_READ_RETRY_DELAYS_MS, readEnsWithRetry } from '../src/ens-retry.ts';

describe('startup ENS read retry (D-082)', () => {
  it('waits 5, 15 and 30 s between reads by default (under a minute in all)', () => {
    assert.deepEqual(ENS_READ_RETRY_DELAYS_MS, [5_000, 15_000, 30_000]);
  });

  it('returns the first good read, after waiting once per failed read', async () => {
    const waits: number[] = [];
    const retries: number[] = [];
    let reads = 0;
    const value = await readEnsWithRetry(
      async () => {
        reads += 1;
        if (reads < 3) throw new Error('Status: 429');
        return 'snapshot';
      },
      {
        sleep: async (ms) => void waits.push(ms),
        onRetry: (attempt) => void retries.push(attempt),
      },
    );
    assert.equal(value, 'snapshot');
    assert.equal(reads, 3);
    assert.deepEqual(waits, [5_000, 15_000]);
    assert.deepEqual(retries, [1, 2]);
  });

  it('throws the last error once every delay is used', async () => {
    let reads = 0;
    await assert.rejects(
      readEnsWithRetry(
        async () => {
          reads += 1;
          throw new Error(`read ${reads}`);
        },
        { delaysMs: [1, 1], sleep: async () => {} },
      ),
      /read 3/,
    );
    assert.equal(reads, 3);
  });

  it('does not wait when the first read succeeds', async () => {
    let waited = false;
    const v = await readEnsWithRetry(async () => 7, {
      sleep: async () => {
        waited = true;
      },
    });
    assert.equal(v, 7);
    assert.equal(waited, false);
  });
});
