// Class: mock. Faked Router responses through the real client, real SQLite
// ledger in memory. Proves every 0G call leaves exactly one ledger row with
// the right status and that both caps refuse before anything is sent.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TriageResult } from '@agent-economy/core/domain';
import { ZgRouterClient, type StructuredTask, type ZgModel } from '@agent-economy/zg';
import { openDatabase } from '../src/db/database.ts';
import { SqliteInferenceLedger } from '../src/ledger/inference-ledger.ts';
import { ledgeredStructuredCall, type LedgeredCallInput } from '../src/inference/ledgered-call.ts';

const SK = 'sk-' + 'k'.repeat(32);
const PROVIDER = '0x1cB95Eb66Cc67C62d4DE0CC96726C5A5d82e7C85';
const NOW = new Date('2026-10-27T08:36:36.801Z');
const TASK: StructuredTask<TriageResult> = {
  name: 'triage',
  instructions: 'Rate the advisory.',
  input: '<advisories>id: CVE-2021-44228</advisories>',
  schema: TriageResult,
};
const MODEL: ZgModel = {
  id: '0gm-1.0-35b-a3b',
  name: '0GM',
  type: 'chatbot',
  contextLength: 8192,
  promptPrice: 389_000_000_000n,
  completionPrice: 2_330_000_000_000n,
  providerCount: 1,
  pricingIssue: null,
  supportedParameters: ['max_tokens', 'response_format', 'chat_template_kwargs'],
};

const VALID =
  '{"assessments":[{"id":"CVE-2021-44228","priority":"p1","exploitedInWild":true,"rationale":"Widely exploited."}],"summary":"Patch Log4j today."}';

type Reply = { status: number; body: unknown } | Error;

function setup(reply: Reply) {
  let sent = 0;
  const client = new ZgRouterClient({
    baseUrl: 'https://router.example/v1',
    apiKey: SK,
    fetch: async () => {
      sent += 1;
      if (reply instanceof Error) throw reply;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const ledger = new SqliteInferenceLedger(openDatabase(':memory:').db);
  let n = 0;
  const deps = {
    client,
    ledger,
    now: () => NOW,
    newId: () => `00000000-0000-4000-8000-${(++n).toString().padStart(12, '0')}`,
  };
  return { deps, ledger, sent: () => sent };
}

const input = (over: Partial<LedgeredCallInput<TriageResult>> = {}) => ({
  runId: null,
  purpose: 'ANALYZE' as const,
  network: 'testnet' as const,
  modelId: MODEL.id,
  catalog: [MODEL],
  task: TASK,
  maxTokens: 512,
  capNeuron: 5_000_000_000_000_000n,
  dailyCapNeuron: 10_000_000_000_000_000n,
  timeoutMs: 5_000,
  ...over,
});

const completion = (content: string) => ({
  status: 200,
  body: {
    id: 'chatcmpl-1',
    model: MODEL.id,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 502, completion_tokens: 229, total_tokens: 731 },
    x_0g_trace: {
      request_id: '3081e4b7-e4e1-43f9-9a0d-b670b6eb4d03',
      provider: PROVIDER,
      billing: {
        input_cost: '201804000000000',
        output_cost: '551890000000000',
        total_cost: '753694000000000',
      },
      tee_verified: true,
    },
  },
});

describe('ledgeredStructuredCall', () => {
  it('records a SUCCEEDED row with the Router billing', async () => {
    const { deps, ledger, sent } = setup(completion(VALID));
    const r = await ledgeredStructuredCall(deps, input());
    assert.equal(r.kind, 'completed');
    assert.equal(sent(), 1);
    const [row] = await ledger.listCalls();
    assert.equal(row?.status, 'SUCCEEDED');
    assert.equal(row?.costNeuron, '753694000000000');
    assert.equal(row?.requestId, '3081e4b7-e4e1-43f9-9a0d-b670b6eb4d03');
    assert.ok(BigInt(row?.worstCaseNeuron ?? '0') >= 753_694_000_000_000n);
    assert.equal((await ledger.spentOnDay('2026-10-27')).spent, 753_694_000_000_000n);
  });

  it('records billed-but-invalid output as FAILED with its cost', async () => {
    const { deps, ledger } = setup(completion('not json'));
    const r = await ledgeredStructuredCall(deps, input());
    assert.equal(r.kind, 'completed');
    const [row] = await ledger.listCalls();
    assert.equal(row?.status, 'FAILED');
    assert.equal(row?.errorCode, 'OUTPUT_NOT_JSON');
    assert.equal(row?.costNeuron, '753694000000000');
  });

  it('records a Router error as FAILED and unbilled (e.g. 402 insufficient_balance)', async () => {
    const { deps, ledger } = setup({
      status: 402,
      body: { error: { type: 'payment_required', code: 'insufficient_balance', message: 'no' } },
    });
    const r = await ledgeredStructuredCall(deps, input());
    assert.equal(r.kind, 'router-error');
    const [row] = await ledger.listCalls();
    assert.equal(row?.status, 'FAILED');
    assert.equal(row?.errorCode, 'ROUTER_402_insufficient_balance');
    assert.equal(row?.costNeuron, null);
    assert.equal((await ledger.spentOnDay('2026-10-27')).spent, 0n);
  });

  it('records a transport failure as UNKNOWN, still counted at the worst case', async () => {
    const { deps, ledger, sent } = setup(new TypeError('fetch failed'));
    const r = await ledgeredStructuredCall(deps, input());
    assert.equal(r.kind, 'unknown');
    assert.equal(sent(), 1, 'never retried');
    const [row] = await ledger.listCalls();
    assert.equal(row?.status, 'UNKNOWN');
    assert.equal(
      (await ledger.spentOnDay('2026-10-27')).spent,
      BigInt(row?.worstCaseNeuron ?? '-1'),
    );
  });

  it('refuses over the per-call cap before sending, with a REFUSED row', async () => {
    const { deps, ledger, sent } = setup(completion('{}'));
    const r = await ledgeredStructuredCall(deps, input({ capNeuron: 1n, dailyCapNeuron: 1n }));
    assert.equal(r.kind === 'refused' ? r.code : r.kind, 'COST_OVER_CAP');
    assert.equal(sent(), 0);
    assert.equal((await ledger.listCalls())[0]?.status, 'REFUSED');
  });

  it('refuses over the daily cap before sending, after earlier spending', async () => {
    const { deps, ledger, sent } = setup(completion(VALID));
    // worst case ~1.47e15 fits; after it settles at 7.5e14, a second worst case does not
    const daily = 2_000_000_000_000_000n;
    assert.equal(
      (await ledgeredStructuredCall(deps, input({ dailyCapNeuron: daily }))).kind,
      'completed',
    );
    assert.equal(
      (await ledgeredStructuredCall(deps, input({ dailyCapNeuron: daily }))).kind,
      'refused',
    );
    assert.equal(sent(), 1, 'the second call was never sent');
    const rows = await ledger.listCalls();
    assert.deepEqual(
      rows.map((r) => `${r.status}:${r.errorCode ?? ''}`),
      ['SUCCEEDED:', 'REFUSED:DAILY_CAP_EXCEEDED'],
    );
  });
});
