/**
 * One live 0G call that must return schema-valid JSON (plan row 17).
 *
 *   pnpm zg:structured                     run the call and print the parsed result
 *   pnpm zg:structured -- --save-evidence  also write docs/evidence/zg/structured-*.json
 *   pnpm zg:structured -- --dry-run        catalog + capability + cost check only
 *   pnpm zg:structured -- --max-tokens 768
 *
 * Task: triage two advisories the agent bought in Phase 14 (NVD CVE-2021-44228,
 * OSV GHSA-35jh-r3h4-6jhm) into the zod TriageResult. The model comes from
 * ZG_MODEL, the timeout from ZG_TIMEOUT_MS, the cap from ZG_MAX_CALL_COST_NEURON.
 * The call uses JSON mode, thinking off when supported, verify_tee, and is
 * never retried. Exit 0 only for schema-valid JSON whose IDs are exactly the
 * input's, a non-zero billed amount, passing billing checks and no failed TEE
 * signature.
 */
import { TriageResult } from '../../packages/core/src/domain/index.ts';
import { loadEnv } from '../../packages/core/src/index.ts';
import {
  ZgRouterClient,
  ZgRouterError,
  callStructured,
  checkBilling,
  routerFloatNote,
  fundingLabel,
  formatZg,
  isRecord,
  jsonSchemaOf,
  parseCallFunding,
  planStructuredCall,
  type BillingCheck,
  type CallFunding,
  type StructuredCallResult,
  type ZgBalance,
} from '../../packages/zg/src/index.ts';
import { TRIAGE_INPUT_IDS, triageTask } from '../lib/triage-sample.ts';
import {
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

const env = loadEnv(['zg'], loadLocalEnvSource());
const network = env.require('ZG_NETWORK');
const modelId = env.require('ZG_MODEL');
const capNeuron = BigInt(env.require('ZG_MAX_CALL_COST_NEURON'));
const timeoutMs = Number(env.require('ZG_TIMEOUT_MS'));
const maxTokensArg = argValue('--max-tokens');
if (maxTokensArg !== undefined && !/^\d{1,4}$/.test(maxTokensArg))
  throw new Error('--max-tokens must be 1-9999');
const maxTokens = Number(maxTokensArg ?? '512');
const managementKey = env.get('ZG_MANAGEMENT_KEY');
const dryRun = hasFlag('--dry-run');
const client = new ZgRouterClient({
  baseUrl: env.require('ZG_ROUTER_BASE_URL'),
  apiKey: env.require('ZG_API_KEY'),
  chatTimeoutMs: timeoutMs,
  ...(managementKey === undefined ? {} : { managementKey }),
});

const INPUT_IDS = TRIAGE_INPUT_IDS;
const task = triageTask;

const startedAt = new Date().toISOString();
const zg = (n: bigint) => `${n} neuron (${formatZg(n)} 0G)`;
console.log(`0G structured-output run on ${network}: ${client.baseUrl}`);
console.log(`  model        ${modelId}  (ZG_MODEL)`);
console.log(`  max_tokens   ${maxTokens} · timeout ${timeoutMs} ms · cap ${zg(capNeuron)}\n`);

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
if (isBalance(balanceBefore))
  console.log(
    `balance      Router float ${zg(balanceBefore.totalBalance)} (refilled from the Payment Layer as you spend)`,
  );

const { models } = await client.listModels();
const plan = planStructuredCall({
  catalog: models,
  modelId,
  task,
  maxTokens,
  capNeuron,
});
if (plan.ok) {
  console.log(
    `catalog      ${modelId} lists response_format${plan.thinkingDisabled ? ' and chat_template_kwargs (thinking off)' : ''}`,
  );
  console.log(`worst case   ${zg(plan.worstCase)} → cost check ALLOWED (cap)`);
  const note = isBalance(balanceBefore)
    ? routerFloatNote(plan.worstCase, balanceBefore.totalBalance)
    : null;
  if (note !== null) console.log(`note         ${note}`);
} else {
  console.log(`plan         REFUSED ${plan.code}: ${plan.reason}`);
  if (plan.code === 'COST_OVER_CAP') {
    console.log(
      '             Raise ZG_MAX_CALL_COST_NEURON in .env (e.g. 5000000000000000 = 0.005 0G) or lower --max-tokens.',
    );
  }
}

let call: StructuredCallResult<TriageResult> | null = null;
let routerError: ZgRouterError | null = null;
let otherError: string | null = null;
let billingChecks: BillingCheck[] = [];
if (plan.ok && !dryRun) {
  console.log(
    '\nsending ONE chat completion (response_format json_object, verify_tee, no retries) ...',
  );
  try {
    call = await callStructured(client, plan, TriageResult, { timeoutMs });
  } catch (error) {
    if (error instanceof ZgRouterError) routerError = error;
    else otherError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

let idsMatchInput = false;
if (call !== null && plan.ok) {
  const c = call.completion;
  billingChecks = checkBilling(c.trace.billing, plan.worstCase, capNeuron);
  console.log(`request_id   ${c.trace.requestId} · provider ${c.trace.provider}`);
  console.log(
    `usage        ${c.usage.promptTokens} in + ${c.usage.completionTokens} out · finish ${c.finishReason ?? '?'}${c.reasoningPresent ? ' (reasoning present)' : ''}`,
  );
  console.log(
    `billing      ${zg(c.trace.billing.totalCost)} · tee_verified ${String(c.trace.teeVerified)}`,
  );
  for (const check of billingChecks)
    console.log(`  ${check.ok ? 'OK  ' : 'FAIL'}  ${check.name}: ${check.detail}`);
  if (call.reading.ok) {
    const ids = call.reading.value.assessments.map((a) => a.id).sort();
    idsMatchInput = JSON.stringify(ids) === JSON.stringify([...INPUT_IDS].sort());
    console.log(`\nSCHEMA-VALID JSON${call.reading.unfenced ? ' (one code fence removed)' : ''}:`);
    for (const a of call.reading.value.assessments) {
      console.log(
        `  ${a.id.padEnd(20)} ${a.priority} · exploited ${a.exploitedInWild} · ${a.rationale}`,
      );
    }
    console.log(`  summary: ${call.reading.value.summary}`);
    console.log(
      `  ids      ${idsMatchInput ? 'exactly the two input advisories' : `UNEXPECTED: ${ids.join(', ')}`}`,
    );
  } else {
    console.log(`\nOUTPUT REJECTED ${call.reading.code}: ${call.reading.reason}`);
    for (const issue of call.reading.issues) console.log(`  ${issue}`);
    console.log(`  content (first 300 chars): ${c.content.slice(0, 300).replace(/\s+/g, ' ')}`);
  }
}
if (routerError !== null) console.log(`router error ${routerError.message}`);
if (otherError !== null)
  console.log(
    `request      failed: ${otherError} (outcome unknown: not retried; check usage history)`,
  );

let funding: CallFunding | null = null;
let usageEntry: unknown = null;
if (call !== null && client.hasManagementKey) {
  try {
    await new Promise((r) => setTimeout(r, 5000));
    const history = await client.getUsageHistory(10);
    const entries: unknown[] = Array.isArray(history)
      ? history
      : isRecord(history) && Array.isArray(history['data'])
        ? history['data']
        : [];
    usageEntry =
      entries.find((e) => JSON.stringify(e).includes(call?.completion.trace.requestId ?? '')) ??
      null;
    funding = parseCallFunding(usageEntry);
  } catch {
    // usage history is informational here
  }
  if (funding !== null) console.log(`funding      ${fundingLabel(funding)}`);
}

const billed = call?.completion.trace.billing.totalCost ?? 0n;
const verified =
  call !== null &&
  call.reading.ok &&
  idsMatchInput &&
  billed > 0n &&
  billingChecks.every((c) => c.ok) &&
  call.completion.trace.teeVerified !== false;

if (hasFlag('--save-evidence')) {
  const c = call?.completion;
  const path = writeEvidence('zg', verified ? 'structured' : 'structured-attempt', {
    kind: 'zg-structured-output',
    startedAt,
    finishedAt: new Date().toISOString(),
    network,
    baseUrl: client.baseUrl,
    model: modelId,
    task: task.name,
    request: {
      response_format: { type: 'json_object' },
      chat_template_kwargs: plan.ok && plan.thinkingDisabled ? { enable_thinking: false } : null,
      max_tokens: maxTokens,
      timeout_ms: timeoutMs,
      verify_tee: true,
      messages: plan.ok ? plan.messages : null,
    },
    jsonSchema: jsonSchemaOf(TriageResult),
    plan: plan.ok
      ? {
          ok: true,
          worstCaseNeuron: plan.worstCase,
          capNeuron,
          thinkingDisabled: plan.thinkingDisabled,
        }
      : plan,
    result:
      c === undefined
        ? null
        : {
            requestId: c.trace.requestId,
            provider: c.trace.provider,
            responseChatId: call?.zgResKey ?? null,
            usage: c.usage,
            billing: c.trace.billing,
            teeVerified: c.trace.teeVerified,
            finishReason: c.finishReason,
            reasoningPresent: c.reasoningPresent,
            content: c.content,
          },
    reading: call?.reading ?? null,
    idsMatchInput,
    billingChecks,
    funding,
    usageHistoryEntry: usageEntry,
    routerError:
      routerError === null
        ? null
        : { status: routerError.status, code: routerError.code, message: routerError.message },
    requestError: otherError,
    schemaValidJsonVerified: verified,
  });
  console.log(`\nEvidence written to ${path}`);
}

if (verified) {
  console.log(
    `\nSTRUCTURED OUTPUT VERIFIED (${fundingLabel(funding)}): the live 0G call returned schema-valid JSON.`,
  );
} else if (dryRun) {
  console.log('\nDRY RUN: no inference was sent.');
  if (!plan.ok) process.exitCode = 1;
} else {
  if (!plan.ok) console.log('\nNO CALL MADE: refused before sending.');
  else console.log('\nNOT VERIFIED: see the lines above.');
  process.exitCode = 1;
}
