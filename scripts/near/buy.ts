/**
 * One paid request on NEAR, end to end, with the agent's function-call key.
 *
 *   pnpm near:buy                                  buy from kev
 *   pnpm near:buy -- --provider osv --save-evidence
 *   pnpm near:buy -- --yes                         answer "yes" if the check warns
 *
 * Steps, each printed:
 *   1. read the provider from the guard contract's registry (not from config)
 *   2. ask the provider: HTTP 402 with a quote
 *   3. check the quote against the registry, then run the counterparty check
 *   4. pay through the guard contract (the contract checks the caps again)
 *   5. ask again with the receipt id; the provider reads the receipt on chain
 *   6. check the delivered data and record the result on the receipt
 *
 * A warning stops and asks on the terminal. A block pays nothing.
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { IntelResponse } from '../../packages/core/src/domain/index.ts';
import { buyFromProvider, checkCounterparty, type HttpGet } from '../../packages/near/src/index.ts';
import {
  UsageError,
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';
import { agentContext, assessmentJson, explorerTx, near, printAssessment } from './lib.ts';

handleScriptErrors();

const QUERIES: Readonly<Record<string, string>> = {
  kev: `recent?since=${new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)}&limit=5`,
  cve: 'lookup?ids=CVE-2021-44228',
  osv: 'query?ecosystem=npm&package=lodash&version=4.17.20',
};

const { network, rpc, guard, agent, thresholds } = agentContext(loadLocalEnvSource());
const label = argValue('--provider') ?? 'kev';
const query = argValue('--query') ?? QUERIES[label];
if (query === undefined) throw new UsageError(`no default query for "${label}": pass --query`);

const httpGet: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
};

const runId = `buy-${randomUUID().slice(0, 8)}`;
console.log(`NEAR buy on ${network}: run ${runId}, agent ${agent.accountId}\n`);

// 1. the registry
const key = await agent.scopedKey();
console.log(
  `  key: function-call only → ${key.permission.receiverId} [${key.permission.methodNames.join(', ') || 'any method'}]`,
);
const provider = (await guard.providers()).find((p) => p.label === label);
if (provider === undefined) throw new UsageError(`"${label}" is not in the guard registry`);
console.log(
  `  registry: ${provider.label} = ${provider.accountId}, ${near(provider.price)} per request`,
);
const url = `${provider.endpoint}/${query}`;
console.log(`  request: GET ${url}\n`);

const result = await buyFromProvider(
  {
    get: httpGet,
    network,
    guardContractId: guard.contractId,
    check: async (receiver, amount) => {
      const assessment = await checkCounterparty(rpc, guard, receiver, amount, thresholds);
      printAssessment(assessment);
      return assessment;
    },
    askHuman: async () => {
      if (hasFlag('--yes')) {
        console.log('  warning accepted with --yes');
        return true;
      }
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('  The check warns. Pay anyway? (yes/no) ');
      rl.close();
      return answer.trim().toLowerCase() === 'yes';
    },
    pay: (request) => {
      console.log(
        `  paying ${near(request.amount)} to ${request.receiver} through ${guard.contractId}`,
      );
      return agent.pay(request);
    },
  },
  { runId, provider, url, maxAmount: provider.price },
);

let passed: boolean | null = null;
let attestHash: string | null = null;
if (result.outcome === 'bought') {
  console.log(
    `  paid: receipt #${result.receiptId}\n    ${explorerTx(network, result.payment.hash)}`,
  );
  // 6. the work check: the data must be a valid intel response from this provider
  const checked = IntelResponse.safeParse(result.data);
  passed = checked.success && checked.data.provider === label;
  const attested = await agent.attest(result.receiptId, passed);
  attestHash = attested.hash;
  console.log(
    `  delivered: ${passed ? `valid data, ${checked.success ? checked.data.count : 0} item(s)` : 'INVALID data'}; recorded on the receipt\n    ${explorerTx(network, attested.hash)}`,
  );
} else if (result.outcome === 'paid-not-delivered') {
  console.log(`  PAID BUT NOT DELIVERED: ${result.reason} (receipt #${result.receiptId})`);
  passed = false;
  attestHash = (await agent.attest(result.receiptId, false)).hash;
} else {
  console.log(`  NOT PAID: ${result.reason}`);
  if (result.outcome === 'rejected') console.log(`    ${explorerTx(network, result.payment.hash)}`);
}

if (hasFlag('--save-evidence')) {
  const receipt =
    result.outcome === 'bought' || result.outcome === 'paid-not-delivered'
      ? await guard.receipt(result.receiptId)
      : null;
  const path = writeEvidence('near', 'buy', {
    kind: 'near-buy',
    at: new Date().toISOString(),
    network,
    guard: guard.contractId,
    agent: agent.accountId,
    agentKey: { publicKey: agent.publicKey, permission: key.permission },
    runId,
    provider: { label: provider.label, accountId: provider.accountId, endpoint: provider.endpoint },
    url,
    outcome: result.outcome,
    reason: 'reason' in result ? result.reason : null,
    quote: result.quote,
    assessment: assessmentJson(result.assessment),
    paymentTransaction: 'payment' in result ? result.payment.hash : null,
    attestTransaction: attestHash,
    workPassed: passed,
    receipt,
  });
  console.log(`\nEvidence written to ${path}`);
}

process.exitCode = result.outcome === 'bought' && passed === true ? 0 : 1;
