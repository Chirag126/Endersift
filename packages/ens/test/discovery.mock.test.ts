// Class: mock (docs/testing.md): a FAKE chain; never counts as network evidence.
// Needs zod via @agent-economy/core (CI and owner's machine).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DiscoveryError,
  REGISTRY_STATUS,
  discoverProviders,
  findDeploymentBlock,
  latestRegistrations,
  scanRegistrationLogs,
  type CachedLogs,
  type DiscoveryChain,
  type RegistrationLog,
} from '../src/discovery.ts';

const SUB = '0x3F54Fcd9ea71D96db6e66aaecCB5B20c3C003758';
const ZERO = '0x0000000000000000000000000000000000000000';
const res = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

const records = (label: string, patch: Record<string, string | null> = {}) => ({
  'agent.endpoint': `http://127.0.0.1:4021/v1/${label}`,
  'agent-endpoint[x402]': `http://127.0.0.1:4021/v1/${label}`,
  'agent.capabilities': `${label}-data`,
  'agent.price': '100000',
  'x402.payTo': '0.0.11044329',
  'x402.network': 'hedera:testnet',
  'x402.asset': '0.0.0',
  'agent.status': 'active',
  ...patch,
});

interface FakeName {
  status: number;
  registryResolver: string;
  urResolver: string | null;
  text: Record<string, string | null>;
}

class FakeChain implements DiscoveryChain {
  head_ = { number: 1000n, hash: `0x${'ab'.repeat(32)}`, timestamp: 1_800_000_000n };
  deployBlock = 100n;
  subregistry = SUB;
  logs: RegistrationLog[] = [];
  names = new Map<string, FakeName>();
  maxRange: bigint | null = null;
  /** Answer "429" to the next N getLogs calls (an RPC plan's rate limit). */
  rateLimited = 0;
  calls = { logs: 0, hasCode: 0 };
  readBlocks = new Set<bigint>();

  add(label: string, block: bigint, name: Partial<FakeName> = {}, tx = `0x${'cd'.repeat(32)}`) {
    this.logs.push({ label, blockNumber: block, transactionHash: tx, logIndex: this.logs.length });
    const r = res(this.names.size + 1);
    this.names.set(label, {
      status: REGISTRY_STATUS.REGISTERED,
      registryResolver: r,
      urResolver: r,
      text: records(label),
      ...name,
    });
  }
  async head() {
    return this.head_;
  }
  async subregistryOf(_parent: string, block: bigint) {
    this.readBlocks.add(block);
    return this.subregistry;
  }
  async hasCode(_a: string, block: bigint) {
    this.calls.hasCode += 1;
    return block >= this.deployBlock;
  }
  async registrationLogs(_r: string, from: bigint, to: bigint) {
    this.calls.logs += 1;
    if (this.rateLimited > 0) {
      this.rateLimited -= 1;
      throw new Error('HTTP request failed. Status: 429 (exceeded its compute units per second)');
    }
    if (this.maxRange !== null && to - from + 1n > this.maxRange)
      throw new Error('range too large');
    return this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
  }
  async statusOf(_r: string, label: string, block: bigint) {
    this.readBlocks.add(block);
    return this.names.get(label)?.status ?? REGISTRY_STATUS.AVAILABLE;
  }
  async registryResolverOf(_r: string, label: string, block: bigint) {
    this.readBlocks.add(block);
    return this.names.get(label)?.registryResolver ?? ZERO;
  }
  async resolverOf(name: string, block: bigint) {
    this.readBlocks.add(block);
    return this.names.get(name.split('.')[0] ?? '')?.urResolver ?? null;
  }
  async textOf(name: string, key: string, block: bigint) {
    this.readBlocks.add(block);
    return this.names.get(name.split('.')[0] ?? '')?.text[key] ?? null;
  }
}

const opts = {
  parentName: 'chirag126.eth',
  parentLabel: 'chirag126',
  chain: 'sepolia' as const,
  allowLocalHttp: true,
  expectedNetwork: 'hedera:testnet' as const,
};

describe('discoverProviders (fake chain)', () => {
  it('turns registration logs into validated providers, pinned to one block', async () => {
    const c = new FakeChain();
    c.add('kev', 200n);
    c.add('cve', 300n);
    const s = await discoverProviders(c, opts);
    assert.deepEqual(
      s.providers.map((p) => p.label),
      ['cve', 'kev'],
    );
    assert.equal(s.blockNumber, 1000n);
    assert.equal(s.fromBlock, 100n, 'deployment block found by search');
    assert.deepEqual([...c.readBlocks], [1000n], 'every read at the pinned block');
    const kev = s.providers.find((p) => p.label === 'kev');
    assert.equal(kev?.registeredAtBlock, 200n);
    assert.equal(kev?.provider.ensName, 'kev.chirag126.eth');
    assert.equal(kev?.provider.discoveredAt, new Date(1_800_000_000_000).toISOString());
  });

  it('shows a newly added agent on the next run without any code change', async () => {
    const c = new FakeChain();
    c.add('kev', 200n);
    const before = await discoverProviders(c, opts);
    c.add('osv', 900n);
    c.head_ = { ...c.head_, number: 1001n };
    const after = await discoverProviders(c, opts);
    assert.ok(!before.providers.some((p) => p.label === 'osv'));
    assert.ok(after.providers.some((p) => p.label === 'osv'));
  });

  it('reports every non-provider label with a reason instead of dropping it', async () => {
    const c = new FakeChain();
    c.add('gone', 200n, { status: REGISTRY_STATUS.AVAILABLE });
    c.add('reserved', 201n, { status: REGISTRY_STATUS.RESERVED });
    c.add('noresolver', 202n, { registryResolver: ZERO, urResolver: null });
    c.add('elsewhere', 203n, { urResolver: res(999) });
    c.add('broken', 204n, { text: records('broken', { 'x402.payTo': '0x1234' }) });
    c.add('paused', 205n, { text: records('paused', { 'agent.status': 'paused' }) });
    c.add('Bad_Label', 206n);
    const s = await discoverProviders(c, opts);
    assert.equal(s.providers.length, 0);
    const codes = Object.fromEntries(s.skipped.map((x) => [x.label, x.code]));
    assert.deepEqual(codes, {
      Bad_Label: 'INVALID_LABEL',
      broken: 'INVALID_RECORDS',
      elsewhere: 'RESOLUTION_PATH_MISMATCH',
      gone: 'NOT_REGISTERED',
      noresolver: 'NO_RESOLVER',
      paused: 'NOT_PURCHASABLE',
      reserved: 'NOT_REGISTERED',
    });
    assert.match(s.skipped.find((x) => x.label === 'broken')?.reason ?? '', /x402\.payTo:INVALID/);
  });

  it('accepts loopback endpoints only in local mode', async () => {
    const c = new FakeChain();
    c.add('kev', 200n);
    const strict = await discoverProviders(c, { ...opts, allowLocalHttp: false });
    assert.equal(strict.providers.length, 0);
    assert.equal(strict.skipped[0]?.code, 'INVALID_RECORDS');
    const https = new FakeChain();
    https.add('kev', 200n, {
      text: records('kev', {
        'agent.endpoint': 'https://api.example.onrender.com/v1/kev',
        'agent-endpoint[x402]': 'https://api.example.onrender.com/v1/kev',
      }),
    });
    assert.equal(
      (await discoverProviders(https, { ...opts, allowLocalHttp: false })).providers.length,
      1,
    );
  });

  it('refuses a network other than the expected one', async () => {
    const c = new FakeChain();
    c.add('kev', 200n, { text: records('kev', { 'x402.network': 'hedera:mainnet' }) });
    const s = await discoverProviders(c, opts);
    assert.equal(s.skipped[0]?.code, 'INVALID_RECORDS');
    assert.match(s.skipped[0]?.reason ?? '', /NETWORK_MISMATCH/);
  });

  it('uses the latest registration of a re-registered label', async () => {
    const c = new FakeChain();
    c.add('kev', 200n);
    c.logs.push({
      label: 'kev',
      blockNumber: 700n,
      transactionHash: `0x${'ef'.repeat(32)}`,
      logIndex: 9,
    });
    const s = await discoverProviders(c, opts);
    assert.equal(s.providers[0]?.registeredAtBlock, 700n);
    assert.equal(s.labelsSeen, 1);
    assert.equal(s.logsScanned, 2);
  });

  it('fails clearly when the parent has no subregistry', async () => {
    const c = new FakeChain();
    c.subregistry = ZERO;
    await assert.rejects(discoverProviders(c, opts), DiscoveryError);
  });
});

describe('log scanning and deployment block', () => {
  it('adapts the getLogs window to the RPC range limit and loses no logs', async () => {
    const c = new FakeChain();
    for (let b = 100n; b < 1000n; b += 37n) c.add(`a${b}`, b);
    c.maxRange = 50n;
    const logs = await scanRegistrationLogs(c, SUB, 100n, 1000n, 1000n, 10n);
    assert.equal(logs.length, c.logs.length);
    assert.deepEqual(
      logs.map((l) => l.blockNumber),
      [...c.logs.map((l) => l.blockNumber)].sort((a, b) => (a < b ? -1 : 1)),
    );
  });

  it('gives up with the RPC error once the minimum window still fails', async () => {
    const c = new FakeChain();
    c.maxRange = 5n;
    await assert.rejects(scanRegistrationLogs(c, SUB, 0n, 100n, 64n, 10n), /range too large/);
  });

  it('finds the first block with code by binary search', async () => {
    const c = new FakeChain();
    c.deployBlock = 11_999_808n;
    assert.equal(await findDeploymentBlock(c, SUB, 12_000_500n), 11_999_808n);
    assert.ok(c.calls.hasCode < 40, 'logarithmic number of reads');
    await assert.rejects(findDeploymentBlock(c, SUB, 10n), DiscoveryError);
  });

  it('keeps the latest registration per label', () => {
    const m = latestRegistrations([
      { label: 'a', blockNumber: 1n, transactionHash: '0x1', logIndex: 0 },
      { label: 'a', blockNumber: 5n, transactionHash: '0x5', logIndex: 0 },
    ]);
    assert.equal(m.get('a')?.transactionHash, '0x5');
  });
});

describe('scan cost on rate-limited RPC plans (D-059)', () => {
  const memoryCache = () => {
    let entry: CachedLogs | null = null;
    return {
      load: () => entry,
      save: (e: CachedLogs) => {
        entry = e;
      },
      get: () => entry,
    };
  };

  it('an RPC limited to 10 blocks is not asked for 20 again after every success', async () => {
    const c = new FakeChain();
    c.add('kev', 500n);
    c.maxRange = 10n;
    const logs = await scanRegistrationLogs(c, SUB, 100n, 1000n, 50_000n, 10n);
    assert.equal(logs.length, 1);
    // 901 blocks / 10 = 91 windows, plus the halvings from 50000 down to 10 (13 refusals)
    assert.ok(c.calls.logs <= 91 + 13, `${c.calls.logs} getLogs calls`);
  });

  it('a rate limit is thrown at once, not mistaken for a range limit, with progress kept', async () => {
    const c = new FakeChain();
    c.add('kev', 150n);
    c.maxRange = 10n;
    let scannedTo = 0n;
    let calls = 0;
    const scan = scanRegistrationLogs(c, SUB, 100n, 1000n, 10n, 10n, {
      onProgress: (_logs, to) => {
        scannedTo = to;
        calls += 1;
        if (calls === 6) c.rateLimited = 1;
      },
    });
    await assert.rejects(scan, /429/);
    assert.equal(scannedTo, 159n, 'six windows of 10 blocks were kept');
  });

  it('the next discovery reads only blocks after the cached ones, and still finds a new agent', async () => {
    const c = new FakeChain();
    c.add('kev', 200n);
    c.add('osv', 300n);
    c.maxRange = 10n;
    const cache = memoryCache();
    const first = await discoverProviders(c, { ...opts, fromBlock: 100n, logCache: cache });
    assert.deepEqual(
      first.providers.map((p) => p.label),
      ['kev', 'osv'],
    );
    const fullScan = c.calls.logs;
    // a new agent registers near the head; the chain moves on by 30 blocks
    c.add('cve', 1020n);
    c.head_ = { ...c.head_, number: 1030n };
    c.calls.logs = 0;
    const second = await discoverProviders(c, { ...opts, fromBlock: 100n, logCache: cache });
    assert.deepEqual(
      second.providers.map((p) => p.label),
      ['cve', 'kev', 'osv'],
    );
    // only the reorg margin (64) plus 30 new blocks, in 10-block windows
    assert.ok(c.calls.logs <= 10, `${c.calls.logs} calls (full scan was ${fullScan})`);
    assert.equal(cache.get()?.scannedTo, 1030n);
  });

  it('a cache for another subregistry, or that starts after the scan start, is not used', async () => {
    const c = new FakeChain();
    c.add('kev', 200n);
    const cache = memoryCache();
    cache.save({
      subregistry: `0x${'11'.repeat(20)}`,
      fromBlock: 100n,
      scannedTo: 1000n,
      logs: [],
    });
    const r = await discoverProviders(c, { ...opts, fromBlock: 100n, logCache: cache });
    assert.deepEqual(
      r.providers.map((p) => p.label),
      ['kev'],
    );
    cache.save({ subregistry: SUB, fromBlock: 500n, scannedTo: 1000n, logs: [] });
    const again = await discoverProviders(c, { ...opts, fromBlock: 100n, logCache: cache });
    assert.deepEqual(
      again.providers.map((p) => p.label),
      ['kev'],
      'a cache starting at 500 cannot vouch for 100..499',
    );
  });
});
