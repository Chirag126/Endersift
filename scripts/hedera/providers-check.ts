/**
 * Probe the running threat-intel service WITHOUT paying (plan row 15):
 *   pnpm providers:start                 (terminal 1)
 *   pnpm providers:check -- --save-evidence   (terminal 2)
 *
 * For every agent: the free description answers 200; the paid route answers
 * 402 with exact Hedera requirements whose amount and payTo equal the
 * service config AND the agent's published ENS records (deployments/sepolia.json
 * `agent.price` / `x402.payTo`); a malformed query answers 400 with no payment
 * requirements. No key is loaded and nothing is signed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadIntelConfig } from '../../apps/providers/src/config.ts';
import { OPERATIONS, operationPath } from '../../apps/providers/src/operations.ts';
import { parseDeployment } from '../../packages/ens/src/deployment.ts';
import { x402Client, x402HTTPClient } from '../../packages/hedera/src/x402.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const config = loadIntelConfig(loadLocalEnvSource());
const base = argValue('--base') ?? `http://127.0.0.1:${config.port}`;
const deployment = existsSync('deployments/sepolia.json')
  ? parseDeployment(readFileSync('deployments/sepolia.json', 'utf8'))
  : null;
const today = new Date().toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
const SAMPLE_QUERY: Record<string, string> = {
  kev: `since=${weekAgo}&limit=5`,
  cve: 'ids=CVE-2021-44228',
  osv: 'ecosystem=npm&package=lodash&version=4.17.20',
};
const BAD_QUERY: Record<string, string> = {
  kev: `since=${today}x`,
  cve: 'ids=nope',
  osv: 'ecosystem=unknown&package=x',
};
const http = new x402HTTPClient(new x402Client());
const startedAt = new Date().toISOString();

async function get(url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body: unknown = await res.json().catch(() => undefined);
    return { res, body, error: null as string | null };
  } catch (error) {
    return {
      res: null,
      body: undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

console.log(`Probing ${base} (no payment)\n`);
const results = [];
for (const p of config.providers) {
  const op = OPERATIONS[p.label];
  if (op === undefined) continue;
  const path = operationPath(p.label, op.name);
  const ens = deployment?.agents.find((a) => a.label === p.label)?.records ?? null;

  const desc = await get(`${base}/v1/${p.label}`);
  const unpaid = await get(`${base}${path}?${SAMPLE_QUERY[p.label] ?? ''}`);
  let quote: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
  } | null = null;
  if (unpaid.res?.status === 402) {
    const req = http.getPaymentRequiredResponse(
      (n) => unpaid.res?.headers.get(n) ?? null,
      unpaid.body,
    ).accepts[0];
    if (req !== undefined)
      quote = {
        scheme: req.scheme,
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        payTo: req.payTo,
      };
  }
  const bad = await get(`${base}${path}?${BAD_QUERY[p.label] ?? ''}`);

  const checks = {
    descriptionFree: desc.res?.status === 200,
    unpaidIs402: unpaid.res?.status === 402,
    quoteMatchesConfig: quote !== null && quote.amount === p.priceAtomic && quote.payTo === p.payTo,
    quoteMatchesEns:
      ens === null
        ? null
        : quote !== null &&
          quote.amount === ens['agent.price'] &&
          quote.payTo === ens['x402.payTo'],
    quoteIsHederaExactHbar:
      quote !== null &&
      quote.scheme === 'exact' &&
      quote.network === config.network &&
      quote.asset === '0.0.0',
    badQueryIs400WithoutQuote:
      bad.res?.status === 400 && bad.res.headers.get('payment-required') === null,
  };
  const ok = Object.values(checks).every((v) => v === true || v === null);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${p.label.padEnd(4)} GET ${path}`);
  console.log(
    `       402 quote: ${quote === null ? `(none: HTTP ${unpaid.res?.status ?? unpaid.error})` : `${quote.amount} tinybars → ${quote.payTo} on ${quote.network}`}`,
  );
  for (const [k, v] of Object.entries(checks)) {
    if (v !== true) console.log(`       ${v === null ? 'skip' : 'FAIL'} ${k}`);
  }
  results.push({
    label: p.label,
    path,
    sampleQuery: SAMPLE_QUERY[p.label],
    quote,
    ensRecords: ens === null ? null : { price: ens['agent.price'], payTo: ens['x402.payTo'] },
    checks,
    ok,
  });
}

const allOk = results.length === config.providers.length && results.every((r) => r.ok);
if (hasFlag('--save-evidence')) {
  const path = writeEvidence('hedera', allOk ? 'providers-402' : 'providers-402-attempt', {
    kind: 'x402-providers-unpaid-probe',
    startedAt,
    finishedAt: new Date().toISOString(),
    base,
    network: config.network,
    results,
    verified: allOk,
  });
  console.log(`\nEvidence written to ${path}`);
}
console.log(
  allOk
    ? `\nALL ${results.length} ROUTES answer 402 with the ENS-published price and payTo.`
    : '\nNOT ALL ROUTES PASSED.',
);
if (!allOk) process.exitCode = 1;
