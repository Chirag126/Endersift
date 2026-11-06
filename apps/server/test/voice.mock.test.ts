// Class: mock. The voice task (D-076) through the real API server, the real 0G
// Router client and the real inference ledger, with a fake speech model.
// Proves the flow, the ledger rows and the link to the task's run; never
// sponsor evidence (a live clip needs 0G credits or a working testnet).
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { createApi, type ApiLimits } from '../src/api/server.ts';
import { TaskRunner } from '../src/api/task-runner.ts';
import {
  cleanTranscript,
  voiceOffReason,
  voiceType,
  VOICE_LINK_WINDOW_MS,
} from '../src/inference/transcribe.ts';
import {
  BUY_KEV,
  BUY_OSV,
  NOW,
  PUBLIC_CONFIG,
  VOICE_TEXT,
  analysisJson,
  harness,
  planJson,
} from './support/orchestrator-harness.ts';

const CODE = 'test-access-code-123';
const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

type Mode = 'ok' | 'no-trace' | 'provider-502' | 'transport';

async function start(
  o: {
    voice?: Mode;
    off?: boolean;
    limits?: Partial<ApiLimits>;
    zgDailyCapNeuron?: bigint;
    voiceText?: string;
  } = {},
) {
  const h = harness({
    plan: () => planJson([BUY_KEV, BUY_OSV]),
    analysis: () => analysisJson(['CVE-2026-1001', 'GHSA-aaaa-bbbb-cccc']),
    ...(o.voice === undefined ? {} : { voice: o.voice }),
    ...(o.voiceText === undefined ? {} : { voiceText: o.voiceText }),
    ...(o.zgDailyCapNeuron === undefined ? {} : { zgDailyCapNeuron: o.zgDailyCapNeuron }),
  });
  const runner = new TaskRunner(h.orchestrator, { maxPending: 3 });
  const api = createApi({
    db: h.db,
    runner,
    payments: h.store,
    inference: h.ledger,
    accessCode: CODE,
    hashscan: (tx) => `https://hashscan.io/testnet/transaction/${encodeURIComponent(tx)}`,
    migration: 10,
    evidenceRoot: 'docs/evidence',
    publicConfig: PUBLIC_CONFIG,
    policy: h.policyStore,
    mode: 'mock',
    schedules: h.scheduleStore,
    corsOrigin: null,
    trustProxyHops: 1,
    secureCookies: false,
    limits: o.limits ?? {},
    sse: { pollMs: 10, heartbeatMs: 50 },
    now: () => NOW.getTime(),
    ...(o.off === true ? {} : { voice: h.voice }),
  });
  const server = createServer((req, res) => void api.handler(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let ip = 0;
  const call = (path: string, init: RequestInit & { client?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set('x-forwarded-for', init.client ?? `203.0.113.${++ip % 250}`);
    return fetch(`${base}${path}`, { ...init, headers });
  };
  const speak = (
    bytes: Uint8Array = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]),
    type = 'audio/webm;codecs=opus',
    headers: Record<string, string> = { authorization: `Bearer ${CODE}` },
  ) =>
    call('/api/voice', {
      method: 'POST',
      headers: { 'content-type': type, ...headers },
      body: new Uint8Array(bytes),
    });
  const task = (body: unknown) =>
    call('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CODE}` },
      body: JSON.stringify(body),
    });
  return { h, runner, call, speak, task };
}

interface CallView {
  id: string;
  purpose: string;
  status: string;
  model: string;
  requestId: string | null;
  costNeuron: string | null;
  worstCaseNeuron: string | null;
  teeVerified: boolean | null;
  runId: string | null;
  errorCode: string | null;
}

describe('voice task (D-076)', () => {
  it('pure helpers: accepted audio types and transcript clean-up', () => {
    assert.equal(voiceType('audio/webm;codecs=opus'), 'audio/webm');
    assert.equal(voiceType('AUDIO/MPEG'), 'audio/mpeg');
    assert.equal(voiceType('audio/x-wav'), 'audio/x-wav');
    assert.equal(voiceType('video/webm'), null);
    assert.equal(voiceType('application/json'), null);
    assert.equal(voiceType(undefined), null);
    assert.equal(
      cleanTranscript('  OpenSSL,\n\tlodash\u0000  and nginx. '),
      'OpenSSL, lodash and nginx.',
    );
    assert.equal(VOICE_LINK_WINDOW_MS, 30 * 60 * 1000);
  });

  it('says why voice is off: no speech model on this network, or a different name', () => {
    // the 0G testnet catalog (docs/evidence/zg/models-testnet-20261025T234248Z.json)
    const testnet = [
      { id: '0gm-1.0-35b-a3b', type: 'chatbot' },
      { id: 'qwen-image-edit', type: 'image-editing' },
    ];
    assert.equal(
      voiceOffReason('whisper-large-v3', testnet, 'testnet'),
      'the 0G testnet catalog has no speech-to-text model; voice works on mainnet',
    );
    // the mainnet catalog names it whisper-large-v3 (models-mainnet-20261025T235143Z.json)
    const mainnet = [
      { id: '0gm-1.0-35b-a3b', type: 'chatbot' },
      { id: 'whisper-large-v3', type: 'speech-to-text' },
    ];
    assert.equal(voiceOffReason('whisper-large-v3', mainnet, 'mainnet'), null);
    // switched off by the owner (D-080): off even when the model is listed
    assert.equal(
      voiceOffReason('off', mainnet, 'mainnet'),
      'switched off by the owner (ZG_STT_MODEL=off)',
    );
    assert.equal(
      voiceOffReason('openai/whisper-large-v3', mainnet, 'mainnet'),
      'openai/whisper-large-v3 is not in the 0G mainnet catalog; set ZG_STT_MODEL to one it lists: whisper-large-v3',
    );
  });

  it('a spoken watchlist: transcribed on 0G, ledgered with its request ID, and joined to the task it starts', async () => {
    const t = await start();
    const res = await t.speak();
    assert.equal(res.status, 200);
    const body = (await res.json()) as { text: string; call: CallView };
    assert.equal(body.text, VOICE_TEXT);
    assert.equal(body.call.purpose, 'TRANSCRIBE');
    assert.equal(body.call.status, 'SUCCEEDED');
    assert.equal(body.call.model, 'whisper-large-v3');
    assert.match(body.call.requestId ?? '', /^a11ce0a0-/);
    assert.equal(body.call.costNeuron, '120000000000000');
    assert.equal(body.call.worstCaseNeuron, '1000000000000000');
    assert.equal(body.call.teeVerified, true);
    assert.equal(body.call.runId, null);

    // the task: watchlist from the transcript, and the 0G call that heard it
    const created = await t.task({
      watchlist: 'OpenSSL, lodash 4.17.21, nginx',
      voiceCallId: body.call.id,
    });
    assert.equal(created.status, 202);
    const c = (await created.json()) as { task: { id: string }; voiceLinked: boolean };
    assert.equal(c.voiceLinked, true);
    await t.runner.idle();
    const detail = (await (await t.call(`/api/tasks/${c.task.id}`)).json()) as {
      inference: CallView[];
      payments: { status: string }[];
    };
    // the task's 0G calls: the voice transcription, then plan and analysis; and its Hedera payments
    assert.deepEqual(
      detail.inference.map((x) => x.purpose),
      ['TRANSCRIBE', 'PLAN', 'ANALYZE'],
    );
    assert.equal(detail.inference[0]?.requestId, body.call.requestId);
    assert.ok(detail.payments.length > 0);

    // one transcription starts one task
    const again = await t.task({ watchlist: 'OpenSSL', voiceCallId: body.call.id });
    assert.equal(again.status, 400);
    assert.match(((await again.json()) as { message: string }).message, /already started a task/);
  });

  it('refuses what it should, before any 0G call', async () => {
    const t = await start();
    assert.equal((await t.speak(undefined, undefined, {})).status, 401);
    assert.equal((await t.speak(undefined, 'video/webm')).status, 415);
    assert.equal((await t.speak(new Uint8Array(0))).status, 400);
    assert.equal((await t.speak(new Uint8Array(1024 * 1024 + 1))).status, 413);
    assert.equal((await t.h.ledger.listCalls({})).length, 0);
    const bad = await t.task({ watchlist: 'OpenSSL', voiceCallId: 'nope' });
    assert.equal(bad.status, 400);
    const unknown = await t.task({
      watchlist: 'OpenSSL',
      voiceCallId: '00000000-0000-4000-8000-0000000000aa',
    });
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { message: string }).message, /no such voice/);
  });

  it('voice off: 503, and a task cannot claim a voice call', async () => {
    const t = await start({ off: true });
    const res = await t.speak();
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, 'VOICE_OFF');
    const task = await t.task({
      watchlist: 'OpenSSL',
      voiceCallId: '00000000-0000-4000-8000-0000000000aa',
    });
    assert.equal(task.status, 400);
  });

  it('a Router error is FAILED with its request ID; a lost connection is UNKNOWN at the worst case', async () => {
    const down = await start({ voice: 'provider-502' });
    const res = await down.speak();
    assert.equal(res.status, 502);
    const b = (await res.json()) as { error: string; message: string; call: CallView };
    assert.equal(b.error, 'TRANSCRIPTION_FAILED');
    assert.equal(b.call.status, 'FAILED');
    assert.equal(b.call.errorCode, 'ROUTER_502_provider_error');
    assert.equal(b.call.requestId, 'e2bfbbe5-0000-4000-8000-0000000a0502');
    assert.equal(b.call.costNeuron, null);

    const lost = await start({ voice: 'transport' });
    const r2 = (await (await lost.speak()).json()) as { call: CallView };
    assert.equal(r2.call.status, 'UNKNOWN');
    assert.equal(r2.call.worstCaseNeuron, '1000000000000000');
    const day = await lost.h.ledger.spentOnDay(NOW.toISOString().slice(0, 10));
    assert.equal(day.spent, 1_000_000_000_000_000n);
  });

  it('text without a request ID and billing: shown, recorded UNKNOWN, nothing invented', async () => {
    const t = await start({ voice: 'no-trace' });
    const res = await t.speak();
    assert.equal(res.status, 200);
    const b = (await res.json()) as { text: string; call: CallView };
    assert.equal(b.text, VOICE_TEXT);
    assert.equal(b.call.status, 'UNKNOWN');
    assert.equal(b.call.requestId, null);
    assert.equal(b.call.errorCode, 'NO_BILLING_TRACE');
  });

  it('the daily 0G cap and the hourly voice limit refuse before spending', async () => {
    const capped = await start({ zgDailyCapNeuron: 500_000_000_000_000n });
    const res = await capped.speak();
    assert.equal(res.status, 409);
    const b = (await res.json()) as { error: string; call: CallView };
    assert.equal(b.error, 'TRANSCRIPTION_REFUSED');
    assert.equal(b.call.status, 'REFUSED');
    assert.equal(b.call.errorCode, 'DAILY_CAP_EXCEEDED');

    // one client, twice, with a limit of one per hour
    const limited = await start({ limits: { voicePerHour: 1 } });
    const once = () =>
      limited.call('/api/voice', {
        method: 'POST',
        headers: { 'content-type': 'audio/webm', authorization: `Bearer ${CODE}` },
        body: new Uint8Array([1, 2]),
        client: '198.51.100.7',
      });
    assert.equal((await once()).status, 200);
    const second = await once();
    assert.equal(second.status, 429);
    assert.equal(((await second.json()) as { error: string }).error, 'TOO_MANY_TRANSCRIPTIONS');
    assert.equal(
      (await limited.h.ledger.listCalls({})).filter((c) => c.purpose === 'TRANSCRIBE').length,
      1,
    );
  });
});
