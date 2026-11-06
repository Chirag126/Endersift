/**
 * Net-guard against the REAL network (plan row 23). Nothing is paid or signed.
 *
 *   pnpm net:check
 *   pnpm net:check -- --save-evidence
 *   pnpm net:check -- --local     also: the local provider service is reachable only in
 *                                 development mode (pnpm providers:start running)
 *
 * Each case expects one outcome; "blocked" cases must never reach a socket.
 * Names that publicly resolve to loopback or the metadata address (localtest.me,
 * 169.254.169.254.nip.io) test DNS-based SSRF; some home routers refuse such
 * answers themselves (DNS rebinding protection), so DNS_FAILED also counts as
 * "never reached" there, and the output says which happened.
 */
import {
  NetGuardError,
  guardedRequest,
  type NetGuardPolicy,
} from '../packages/net-guard/src/index.ts';
import { handleScriptErrors, hasFlag, writeEvidence } from './lib/cli.ts';

handleScriptErrors();

interface Case {
  readonly name: string;
  readonly url: string;
  readonly expect: readonly string[];
  readonly policy?: NetGuardPolicy;
  readonly method?: string;
  readonly body?: string;
}

const cases: Case[] = [
  {
    name: 'public https API (OSV), pinned',
    url: 'https://api.osv.dev/v1/query',
    method: 'POST',
    body: JSON.stringify({ package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.20' }),
    expect: ['OK'],
    policy: { maxBytes: 4 * 1024 * 1024 },
  },
  {
    name: 'oversize: CISA KEV catalogue with a 64 KiB cap',
    url: 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
    expect: ['RESPONSE_TOO_LARGE'],
    policy: { maxBytes: 64 * 1024 },
  },
  {
    name: 'redirect is not followed (GitHub latest release)',
    url: 'https://github.com/coinbase/x402/releases/latest',
    expect: ['REDIRECT_REFUSED'],
  },
  {
    name: 'time cap (1 ms)',
    url: 'https://api.osv.dev/v1/query',
    method: 'POST',
    body: '{}',
    expect: ['TIMEOUT'],
    policy: { timeoutMs: 1 },
  },
  { name: 'plain http', url: 'http://example.com/', expect: ['SCHEME_NOT_ALLOWED'] },
  {
    name: 'cloud metadata IP literal',
    url: 'https://169.254.169.254/latest/meta-data/',
    expect: ['ADDRESS_BLOCKED'],
  },
  { name: 'loopback IP literal', url: 'https://127.0.0.1/', expect: ['ADDRESS_BLOCKED'] },
  { name: 'IPv6 loopback literal', url: 'https://[::1]/', expect: ['ADDRESS_BLOCKED'] },
  {
    name: 'IPv4-mapped IPv6 metadata',
    url: 'https://[::ffff:169.254.169.254]/',
    expect: ['ADDRESS_BLOCKED'],
  },
  {
    name: 'public name → 127.0.0.1 (localtest.me)',
    url: 'https://localtest.me/',
    expect: ['ADDRESS_BLOCKED', 'DNS_FAILED'],
  },
  {
    name: 'public name → metadata IP (169.254.169.254.nip.io)',
    url: 'https://169.254.169.254.nip.io/latest/meta-data/',
    expect: ['ADDRESS_BLOCKED', 'DNS_FAILED'],
  },
  {
    name: 'credentials in URL',
    url: 'https://user:pass@api.osv.dev/',
    expect: ['CREDENTIALS_IN_URL'],
  },
  { name: 'non-443 port', url: 'https://api.osv.dev:8443/', expect: ['PORT_NOT_ALLOWED'] },
];
if (hasFlag('--local')) {
  cases.push(
    {
      name: 'local provider, production mode',
      url: 'http://127.0.0.1:4021/v1/kev',
      expect: ['SCHEME_NOT_ALLOWED'],
    },
    {
      name: 'local provider, development mode',
      url: 'http://127.0.0.1:4021/v1/kev',
      expect: ['OK'],
      policy: { allowLoopbackHttp: true },
    },
  );
}

const startedAt = new Date().toISOString();
const results = [];
for (const c of cases) {
  let got: string;
  let detail: string;
  let pinned: string | null = null;
  let status: number | null = null;
  try {
    const res = await guardedRequest(
      c.url,
      {
        method: c.method ?? 'GET',
        headers: c.body === undefined ? {} : { 'content-type': 'application/json' },
        body: c.body === undefined ? null : new TextEncoder().encode(c.body),
      },
      c.policy ?? {},
    );
    got = 'OK';
    status = res.status;
    pinned = res.target.pinned.address;
    detail = `HTTP ${res.status}, ${res.body.byteLength} bytes, pinned to ${pinned} (${res.target.resolved.length} address(es) checked)`;
  } catch (error) {
    got = error instanceof NetGuardError ? error.code : 'UNEXPECTED';
    detail = error instanceof Error ? error.message : String(error);
  }
  const ok = c.expect.includes(got);
  results.push({ name: c.name, url: c.url, expect: c.expect, got, ok, status, pinned, detail });
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(50)} expect ${c.expect.join('|').padEnd(26)} got ${got}`,
  );
  if (!ok || got === 'DNS_FAILED') console.log(`       ${detail}`);
}

const verified = results.every((r) => r.ok);
if (hasFlag('--save-evidence')) {
  const path = writeEvidence('net', verified ? 'net-guard' : 'net-guard-attempt', {
    kind: 'net-guard-live-check',
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    results,
    verified,
  });
  console.log(`\nEvidence written to ${path}`);
}
console.log(
  verified
    ? `\nNET-GUARD VERIFIED: ${results.length}/${results.length} cases as expected on the real network; no blocked target was ever connected to.`
    : '\nNOT VERIFIED: see the FAIL lines above.',
);
if (!verified) process.exitCode = 1;
