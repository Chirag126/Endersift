// Class: unit. URL and DNS checks with a fake resolver (private answers,
// mixed answers, DNS rebinding), and the pinned transport against REAL local
// sockets: oversize (declared and streamed), redirects, timeouts, pinning.
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  NetGuardError,
  checkTarget,
  createGuardedFetch,
  guardedRequest,
  nodeTransport,
  type Resolver,
  type Transport,
} from '../src/index.ts';

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof NetGuardError ? e.code : `UNEXPECTED ${String(e)}`;
  }
};

const resolverOf =
  (answers: Record<string, string[]>): Resolver =>
  async (host) => {
    const a = answers[host];
    if (a === undefined) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

describe('checkTarget: URLs', () => {
  const r = resolverOf({ 'api.example': ['93.184.215.14'] });
  it('accepts https to a public address and pins it', async () => {
    const t = await checkTarget('https://api.example/v1/kev', {}, r);
    assert.equal(t.pinned.address, '93.184.215.14');
    assert.equal(t.port, 443);
  });

  it('refuses other schemes, credentials, odd ports and junk', async () => {
    for (const [url, code] of [
      ['http://api.example/', 'SCHEME_NOT_ALLOWED'],
      ['ftp://api.example/', 'SCHEME_NOT_ALLOWED'],
      ['file:///etc/passwd', 'SCHEME_NOT_ALLOWED'],
      ['https://user:pw@api.example/', 'CREDENTIALS_IN_URL'],
      ['https://api.example:8443/', 'PORT_NOT_ALLOWED'],
      ['https://api.example:22/', 'PORT_NOT_ALLOWED'],
      ['not a url', 'URL_INVALID'],
    ] as const)
      assert.equal(await codeOf(checkTarget(url, {}, r)), code, url);
    assert.equal(
      await codeOf(checkTarget('https://api.example:8443/', { allowedPorts: [443, 8443] }, r)),
      'OK',
    );
  });

  it('refuses IP-literal URLs in blocked ranges (metadata, private, loopback, mapped IPv6)', async () => {
    for (const url of [
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://[::ffff:169.254.169.254]/',
      'https://[fd00::1]/',
      'https://0.0.0.0/',
    ])
      assert.equal(await codeOf(checkTarget(url, {}, r)), 'ADDRESS_BLOCKED', url);
  });

  it('http to loopback only with the development flag, and only for loopback hosts', async () => {
    const dev = { allowLoopbackHttp: true };
    const local = resolverOf({ localhost: ['127.0.0.1'], 'evil.example': ['127.0.0.1'] });
    assert.equal(await codeOf(checkTarget('http://127.0.0.1:4021/v1/kev', dev, local)), 'OK');
    assert.equal(await codeOf(checkTarget('http://localhost:4021/v1/kev', dev, local)), 'OK');
    assert.equal(
      await codeOf(checkTarget('http://127.0.0.1:4021/v1/kev', {}, local)),
      'SCHEME_NOT_ALLOWED',
    );
    // a public-looking name that points at loopback is still refused in dev mode
    assert.equal(await codeOf(checkTarget('https://evil.example/', dev, local)), 'ADDRESS_BLOCKED');
    assert.equal(await codeOf(checkTarget('http://10.0.0.1/', dev, local)), 'SCHEME_NOT_ALLOWED');
  });
});

describe('checkTarget: DNS', () => {
  it('refuses a name resolving to a private address', async () => {
    const r = resolverOf({ 'internal.example': ['10.1.2.3'], 'meta.example': ['169.254.169.254'] });
    assert.equal(await codeOf(checkTarget('https://internal.example/', {}, r)), 'ADDRESS_BLOCKED');
    assert.equal(await codeOf(checkTarget('https://meta.example/', {}, r)), 'ADDRESS_BLOCKED');
  });

  it('refuses a name with ANY private address among public ones', async () => {
    const r = resolverOf({ 'mixed.example': ['93.184.215.14', '192.168.0.10'] });
    assert.equal(await codeOf(checkTarget('https://mixed.example/', {}, r)), 'ADDRESS_BLOCKED');
  });

  it('refuses IPv6 answers that embed private IPv4 (NAT64, 6to4)', async () => {
    const r = resolverOf({ a: ['64:ff9b::a00:1'], b: ['2002:c0a8:0101::1'] });
    assert.equal(await codeOf(checkTarget('https://a/', {}, r)), 'ADDRESS_BLOCKED');
    assert.equal(await codeOf(checkTarget('https://b/', {}, r)), 'ADDRESS_BLOCKED');
  });

  it('reports DNS failure and empty answers', async () => {
    assert.equal(
      await codeOf(checkTarget('https://nx.example/', {}, resolverOf({}))),
      'DNS_FAILED',
    );
    assert.equal(
      await codeOf(checkTarget('https://e.example/', {}, resolverOf({ 'e.example': [] }))),
      'DNS_FAILED',
    );
  });

  it('caps DNS time too: a resolver that never answers is a TIMEOUT', async () => {
    const hang: Resolver = () => new Promise(() => {});
    assert.equal(
      await codeOf(checkTarget('https://slow.example/', { timeoutMs: 50 }, hang)),
      'TIMEOUT',
    );
  });

  it('DNS rebinding: resolves once and the transport gets the checked address', async () => {
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls += 1;
      return [{ address: calls === 1 ? '93.184.215.14' : '127.0.0.1', family: 4 }];
    };
    const seen: string[] = [];
    const transport: Transport = async (target) => {
      seen.push(target.pinned.address);
      // a second lookup by anyone now would say 127.0.0.1; the socket must not care
      assert.equal((await rebinding('rebind.example'))[0]?.address, '127.0.0.1');
      return { status: 200, headers: {}, body: new Uint8Array() };
    };
    await guardedRequest('https://rebind.example/', {}, {}, { resolve: rebinding, transport });
    assert.deepEqual(seen, ['93.184.215.14']);
  });
});

// ── real sockets ─────────────────────────────────────────────────────────────

let server: Server;
let port = 0;
const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  '/ok': (_q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' });
    s.end('{"ok":true}');
  },
  '/echo': (q, s) => {
    let body = '';
    q.on('data', (c: Buffer) => (body += c.toString()));
    q.on('end', () => {
      s.writeHead(200, { 'content-type': 'application/json' });
      s.end(
        JSON.stringify({
          method: q.method,
          host: q.headers.host,
          body,
          x: q.headers['x-test'] ?? null,
        }),
      );
    });
  },
  '/declared-big': (_q, s) => {
    s.writeHead(200, { 'content-length': String(10_000) });
    s.end('x'.repeat(10_000));
  },
  '/streamed-big': (_q, s) => {
    s.writeHead(200); // chunked, no Content-Length
    for (let i = 0; i < 20; i += 1) s.write('y'.repeat(1_000));
    s.end();
  },
  '/redirect': (_q, s) => {
    s.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    s.end();
  },
  '/slow': (_q, s) => {
    s.writeHead(200);
    s.write('partial');
    setTimeout(() => s.end('late'), 2_000).unref();
  },
};

before(async () => {
  server = createServer((q, s) =>
    (routes[new URL(q.url ?? '/', 'http://x').pathname] ?? routes['/ok'])?.(q, s),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

const dev = (over = {}) => ({ allowLoopbackHttp: true, ...over });
const base = () => `http://127.0.0.1:${port}`;

describe('pinned transport (real sockets)', () => {
  it('returns status, headers and body; forwards method, headers and body', async () => {
    const f = createGuardedFetch(dev());
    const res = await f(`${base()}/echo`, {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'x-test': 'yes' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      method: 'POST',
      host: `127.0.0.1:${port}`,
      body: '{"a":1}',
      x: 'yes',
    });
  });

  it('refuses oversize responses: declared Content-Length and streamed bodies', async () => {
    assert.equal(
      await codeOf(guardedRequest(`${base()}/declared-big`, {}, dev({ maxBytes: 1_000 }))),
      'RESPONSE_TOO_LARGE',
    );
    assert.equal(
      await codeOf(guardedRequest(`${base()}/streamed-big`, {}, dev({ maxBytes: 5_000 }))),
      'RESPONSE_TOO_LARGE',
    );
    assert.equal(
      await codeOf(guardedRequest(`${base()}/streamed-big`, {}, dev({ maxBytes: 50_000 }))),
      'OK',
    );
  });

  it('never follows redirects (here: to the cloud metadata address)', async () => {
    assert.equal(await codeOf(guardedRequest(`${base()}/redirect`, {}, dev())), 'REDIRECT_REFUSED');
  });

  it('enforces the total time cap even after headers arrived', async () => {
    const started = Date.now();
    assert.equal(
      await codeOf(guardedRequest(`${base()}/slow`, {}, dev({ timeoutMs: 300 }))),
      'TIMEOUT',
    );
    assert.ok(Date.now() - started < 1_500);
  });

  it('connects to the pinned address, whatever the hostname resolves to', async () => {
    // "pinned.invalid" does not resolve at all; the socket still reaches the checked address,
    // and the Host header keeps the original name.
    const target = {
      url: new URL(`http://pinned.invalid:${port}/echo`),
      hostname: 'pinned.invalid',
      port,
      pinned: { address: '127.0.0.1', family: 4 as const },
      resolved: [{ address: '127.0.0.1', family: 4 as const }],
    };
    const res = await nodeTransport(
      target,
      { method: 'GET', headers: {}, body: null },
      { maxBytes: 10_000, timeoutMs: 2_000 },
    );
    const body = JSON.parse(new TextDecoder().decode(res.body)) as { host: string };
    assert.equal(body.host, `pinned.invalid:${port}`);
  });

  it('a closed port is a connection failure, not a hang', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const p = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    assert.equal(
      await codeOf(guardedRequest(`http://127.0.0.1:${p}/`, {}, dev({ timeoutMs: 2_000 }))),
      'CONNECTION_FAILED',
    );
  });
});
