// Class: unit. The ENS registration-log cache file (D-059): round trip, and
// any malformed or hostile content is ignored (the scan then starts over).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileLogCache, parseCachedLogs, serializeCachedLogs } from '../src/ens-log-cache.ts';

const ENTRY = {
  subregistry: '0x3F54Fcd9ea71D96db6e66aaecCB5B20c3C003758',
  fromBlock: 11_999_808n,
  scannedTo: 12_010_634n,
  refusedRange: 20n,
  logs: [
    {
      label: 'kev',
      blockNumber: 11_999_810n,
      transactionHash: `0x${'ab'.repeat(32)}`,
      logIndex: 3,
    },
  ],
};

describe('ENS log cache file', () => {
  it('round-trips through the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'enscache-'));
    try {
      const cache = fileLogCache(join(dir, 'nested', 'ens-log-cache.json'));
      assert.equal(cache.load(), null);
      cache.save(ENTRY);
      assert.deepEqual(cache.load(), ENTRY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores malformed or hostile content', () => {
    const good = JSON.parse(serializeCachedLogs(ENTRY)) as Record<string, unknown>;
    const bad = [
      'not json',
      '[]',
      JSON.stringify({ ...good, subregistry: 'evil' }),
      JSON.stringify({ ...good, scannedTo: '1' }),
      JSON.stringify({ ...good, fromBlock: '-5' }),
      JSON.stringify({
        ...good,
        logs: [{ label: 'Bad Label', blockNumber: '1', transactionHash: '0x', logIndex: 0 }],
      }),
      JSON.stringify({ ...good, logs: 'nope' }),
    ];
    for (const text of bad) assert.equal(parseCachedLogs(text), null, text.slice(0, 60));
    const dir = mkdtempSync(join(tmpdir(), 'enscache-'));
    try {
      const path = join(dir, 'c.json');
      writeFileSync(path, '{"subregistry":');
      assert.equal(fileLogCache(path).load(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
