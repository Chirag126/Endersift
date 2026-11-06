/**
 * One credit-funded 0G Private Computer inference call, with evidence.
 *
 *   pnpm zg:infer                     run the call and print the result
 *   pnpm zg:infer -- --save-evidence  also write docs/evidence/zg/inference-*.json
 *   pnpm zg:infer -- --dry-run        catalog + cost check + balance only; no inference
 *
 * Steps:
 *  1. Balance before (only if ZG_MANAGEMENT_KEY is set; sk- keys cannot read it).
 *  2. Live catalog + deterministic check BEFORE sending: ZG_MODEL must be a
 *     priced chatbot model; worst case (prompt byte bound + ZG_OUTPUT_LIMIT)
 *     must fit ZG_MAX_CALL_COST_NEURON and the spendable balance, else nothing is sent.
 *  4. ONE chat completion with verify_tee: true. Never retried.
 *  5. Record x_0g_trace: request_id, provider, exact billing, tee_verified.
 *     Check billing: total = input + output, within the worst case and the cap.
 *  6. Balance after (polled up to 60 s, the Router syncs in batches) and the
 *     usage-history entry for this request_id.
 *
 * Exit 0 only when the call succeeded, was billed a non-zero amount, the
 * billing checks pass, and the Router did not report a failed TEE signature.
 * The verdict states what paid for the call (credits vs deposit) from the
 * Router's own usage record; only credit_used > 0 counts as credit-funded.
 */
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  ZgRouterClient,
  ZgRouterError,
  checkBilling,
  routerFloatNote,
  checkCallCost,
  formatZg,
  fundingLabel,
  parseCallFunding,
  isRecord,
  type BillingCheck,
  type ChatResult,
  type ZgBalance,
  type ZgMessage,
} from '../../packages/zg/src/index.ts';
import { handleScriptErrors, hasFlag, loadLocalEnvSource, writeEvidence } from '../lib/cli.ts';

handleScriptErrors();

const source = loadLocalEnvSource();
const env = loadEnv(['zg'], source);
const network = env.require('ZG_NETWORK');
const modelId = env.require('ZG_MODEL');
const maxTokens = Number(env.require('ZG_OUTPUT_LIMIT'));
const capNeuron = BigInt(env.require('ZG_MAX_CALL_COST_NEURON'));
const managementKey = env.get('ZG_MANAGEMENT_KEY');
const dryRun = hasFlag('--dry-run');

const client = new ZgRouterClient({
  baseUrl: env.require('ZG_ROUTER_BASE_URL'),
  apiKey: env.require('ZG_API_KEY'),
  ...(managementKey === undefined ? {} : { managementKey }),
});

// A fixed, product-shaped prompt: the planning step of the threat-intel agent.
const MESSAGES: ZgMessage[] = [
  {
    role: 'system',
    content:
      'You are the planning module of a budget-bounded threat-intelligence agent. Answer briefly.',
  },
  {
    role: 'user',
    content:
      'In two sentences: what does the CISA Known Exploited Vulnerabilities catalog contain, and why should a security team check it daily?',
  },
];

const startedAt = new Date().toISOString();
const zg = (n: bigint) => `${n} neuron (${formatZg(n)} 0G)`;

console.log(`0G inference run on ${network}: ${client.baseUrl}`);
console.log(`  model        ${modelId}`);
console.log(`  max_tokens   ${maxTokens}`);
console.log(`  cap          ${zg(capNeuron)}`);
console.log(
  `  balance read ${client.hasManagementKey ? 'yes (ZG_MANAGEMENT_KEY)' : 'no (set ZG_MANAGEMENT_KEY to record before/after)'}\n`,
);

// 1. Balance before (read first so the cost check can use it)
async function readBalance(): Promise<ZgBalance | { error: string }> {
  try {
    return await client.getBalance();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
const isBalance = (b: ZgBalance | { error: string } | null): b is ZgBalance =>
  b !== null && !('error' in b);

const balanceBefore = client.hasManagementKey ? await readBalance() : null;
if (isBalance(balanceBefore)) {
  console.log(
    `balance      ${zg(balanceBefore.totalBalance)} available (wallet ${balanceBefore.address})`,
  );
} else if (balanceBefore !== null) {
  console.log(`balance      could not read: ${balanceBefore.error}`);
}

// 2. Catalog and cost check (per-call cap; the Router balance is only a float, D-039)
const { models } = await client.listModels();
const decision = checkCallCost({
  catalog: models,
  modelId,
  messages: MESSAGES,
  maxTokens,
  capNeuron,
});
if (decision.ok) {
  console.log(
    `catalog      ${modelId}: ${decision.model.promptPrice} in / ${decision.model.completionPrice} out neuron per token`,
  );
  console.log(
    `worst case   ${zg(decision.worstCase)} (≤ ${decision.promptTokenBound} prompt + ${maxTokens} output tokens)`,
  );
  console.log('cost check   ALLOWED (cap)');
  const note = isBalance(balanceBefore)
    ? routerFloatNote(decision.worstCase, balanceBefore.totalBalance)
    : null;
  if (note !== null) console.log(`note         ${note}`);
} else {
  console.log(`cost check   REFUSED ${decision.code}: ${decision.reason}`);
}

// 4-5. The call
let result: ChatResult | null = null;
let routerError: ZgRouterError | null = null;
let otherError: string | null = null;
let billingChecks: BillingCheck[] = [];

if (decision.ok && !dryRun) {
  console.log('\nsending ONE chat completion (verify_tee: true, no retries) ...');
  try {
    result = await client.chat({ model: modelId, messages: MESSAGES, maxTokens, verifyTee: true });
  } catch (error) {
    if (error instanceof ZgRouterError) routerError = error;
    else otherError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

if (result !== null && decision.ok) {
  const { completion: c } = result;
  billingChecks = checkBilling(c.trace.billing, decision.worstCase, capNeuron);
  console.log(`request_id   ${c.trace.requestId}`);
  console.log(`chat id      ${c.id ?? '(none)'}  ZG-Res-Key ${result.zgResKey ?? '(none)'}`);
  console.log(`model        ${c.model}`);
  console.log(`provider     ${c.trace.provider}`);
  console.log(
    `usage        ${c.usage.promptTokens} in + ${c.usage.completionTokens} out = ${c.usage.totalTokens} tokens`,
  );
  console.log(
    `billing      ${zg(c.trace.billing.totalCost)} (in ${c.trace.billing.inputCost}, out ${c.trace.billing.outputCost})`,
  );
  console.log(`tee_verified ${String(c.trace.teeVerified)}`);
  console.log(
    `finish       ${c.finishReason ?? '?'}${c.reasoningPresent ? ' (reasoning tokens present)' : ''}`,
  );
  console.log(
    `answer       ${c.content.slice(0, 400).replace(/\s+/g, ' ') || '(empty: output budget may have gone to reasoning)'}`,
  );
  for (const check of billingChecks)
    console.log(`  ${check.ok ? 'OK  ' : 'FAIL'}  ${check.name}: ${check.detail}`);
}
if (routerError !== null) {
  console.log(`router error ${routerError.message}`);
  if (routerError.code === 'insufficient_balance') {
    console.log(
      '             The key works but the account has no spendable balance: deposit first.',
    );
  }
}
if (otherError !== null)
  console.log(
    `request      failed: ${otherError} (outcome unknown: do not re-run blindly; check usage history)`,
  );

// 6. Balance after + usage history
let balanceAfter: ZgBalance | { error: string } | null = null;
let balanceDelta: bigint | null = null;
let usageEntry: unknown = null;
const billed = result?.completion.trace.billing.totalCost ?? null;

if (isBalance(balanceBefore) && result !== null) {
  console.log('\nwaiting for the balance to reflect the charge (up to 60 s) ...');
  const deadline = Date.now() + 60_000;
  for (;;) {
    balanceAfter = await readBalance();
    if (isBalance(balanceAfter) && balanceAfter.totalBalance < balanceBefore.totalBalance) break;
    if (Date.now() + 5_000 > deadline) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  if (isBalance(balanceAfter)) {
    balanceDelta = balanceBefore.totalBalance - balanceAfter.totalBalance;
    console.log(`balance      ${zg(balanceAfter.totalBalance)} available`);
    console.log(
      `delta        ${zg(balanceDelta)} ${billed !== null && balanceDelta === billed ? '= billed amount' : balanceDelta === 0n ? '(not yet synced; re-check the dashboard later)' : '(differs from billed amount: other usage or batching)'}`,
    );
  }
  try {
    const history = await client.getUsageHistory(10);
    const entries: unknown[] = Array.isArray(history)
      ? history
      : isRecord(history) && Array.isArray(history['data'])
        ? history['data']
        : [];
    const id = result.completion.trace.requestId;
    usageEntry = entries.find((e) => JSON.stringify(e).includes(id)) ?? null;
    console.log(
      `usage log    ${usageEntry === null ? `request ${id} not (yet) in the last 10 entries` : 'entry found for this request_id'}`,
    );
  } catch (error) {
    console.log(
      `usage log    could not read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const funding = parseCallFunding(usageEntry);
if (funding !== null) {
  console.log(
    `funding      credit_used ${funding.creditUsed} · deposit_used ${funding.depositUsed} → ${fundingLabel(funding)}`,
  );
}

const teeFailed = result?.completion.trace.teeVerified === false;
const verified =
  result !== null &&
  billed !== null &&
  billed > 0n &&
  billingChecks.every((c) => c.ok) &&
  !teeFailed;

if (hasFlag('--save-evidence')) {
  const c = result?.completion;
  const path = writeEvidence('zg', verified ? 'inference' : 'inference-attempt', {
    kind: 'zg-inference',
    startedAt,
    finishedAt: new Date().toISOString(),
    network,
    baseUrl: client.baseUrl,
    model: modelId,
    dryRun,
    request: { messages: MESSAGES, max_tokens: maxTokens, verify_tee: true },
    costCheck: decision.ok
      ? {
          ok: true,
          promptNeuronPerToken: decision.model.promptPrice,
          completionNeuronPerToken: decision.model.completionPrice,
          promptTokenBound: decision.promptTokenBound,
          worstCaseNeuron: decision.worstCase,
          capNeuron,
        }
      : { ...decision, capNeuron },
    balanceBefore,
    result:
      c === undefined
        ? null
        : {
            httpStatus: result?.httpStatus ?? null,
            requestId: c.trace.requestId,
            chatId: c.id,
            // ZG-Res-Key header: public chat ID for TEE signature lookup (not a secret).
            responseChatId: result?.zgResKey ?? null,
            model: c.model,
            provider: c.trace.provider,
            usage: c.usage,
            billing: c.trace.billing,
            teeVerified: c.trace.teeVerified,
            finishReason: c.finishReason,
            reasoningPresent: c.reasoningPresent,
            answer: c.content,
          },
    billingChecks,
    balanceAfter,
    balanceDeltaNeuron: balanceDelta,
    balanceDeltaMatchesBilling:
      balanceDelta !== null && billed !== null ? balanceDelta === billed : null,
    usageHistoryEntry: usageEntry,
    funding,
    routerError:
      routerError === null
        ? null
        : {
            status: routerError.status,
            type: routerError.type,
            code: routerError.code,
            requestId: routerError.requestId,
            message: routerError.message,
          },
    requestError: otherError,
    rawResponse: result?.raw ?? null,
    paidInferenceVerified: verified,
    creditFunded: funding === null ? null : funding.creditUsed > 0n,
  });
  console.log(`\nEvidence written to ${path}`);
}

if (verified) {
  console.log(
    `\nPAID INFERENCE VERIFIED (${fundingLabel(funding)}): billed by the 0G Router, billing checks pass.`,
  );
  if (funding?.source !== 'credits' && funding?.source !== 'mixed') {
    console.log('Note: G1 needs credit_used > 0 on a mainnet call funded by team/iAI credits.');
  }
} else if (dryRun) {
  console.log('\nDRY RUN: no inference was sent.');
  if (!decision.ok) process.exitCode = 1;
} else if (!decision.ok) {
  console.log('\nNO CALL MADE: refused by the cost/balance check before sending.');
  process.exitCode = 1;
} else {
  console.log(
    teeFailed
      ? '\nNOT VERIFIED: the Router reported a FAILED TEE signature.'
      : '\nNOT VERIFIED: see the lines above.',
  );
  process.exitCode = 1;
}
