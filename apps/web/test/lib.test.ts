// Class: unit. The web app's pure logic: exact money formatting, budget
// validation, the run trail, the daily activity charts, the safe
// markdown reader and API error messages.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeApiError } from '../src/lib/api.ts';
import { isLocalhost } from '../src/lib/deployment.ts';
import {
  etherscanAddress,
  etherscanBlock,
  etherscanToken,
  hashscanTopic,
  hashscanTransaction,
  safeHref,
} from '../src/lib/explorers.ts';
import {
  grouped,
  hbar,
  liveNetworksLabel,
  middle,
  parseHbar,
  percentOf,
  utcTime,
  zg,
  zgAmount,
} from '../src/lib/format.ts';
import { parseInline, parseMarkdown } from '../src/lib/markdown.ts';
import { mergeEntries, moreAction } from '../src/lib/logs.ts';
import {
  checkBudget,
  checkDraft,
  draftDirty,
  draftOf,
  policyChanges,
  ruleSentences,
  sameLimits,
} from '../src/lib/policy.ts';
import { countdownText, secondsLeft } from '../src/lib/approvals.ts';
import {
  DEFAULT_AUDIO,
  END_FADE_SEC,
  RESTART_GAP_MS,
  TAB_TRACKS,
  endFadeGain,
  firstAudible,
  isSoundTarget,
  musicStatusText,
  parseAudioPrefs,
  playbackVolume,
  readAudioPrefs,
  tabForRoute,
  trackForRoute,
  trackUrl,
  writeAudioPrefs,
} from '../src/lib/audio.ts';
import {
  DEFAULT_THEME,
  THEMES,
  THEME_STORAGE_KEY,
  currentTheme,
  forgetSavedTheme,
  onThemeChange,
  parseTheme,
  setTheme,
} from '../src/lib/theme.ts';
import {
  MAX_RECORD_SEC,
  clipType,
  pickRecordingType,
  spokenToWatchlist,
  voiceReceipt,
} from '../src/lib/voice.ts';
import { VERDICT_TEXT, auditSettling, verdictTone } from '../src/lib/runs.ts';
import { byDay, dayLabel, dayStart, lastUtcDays, share } from '../src/lib/activity.ts';
import { agentState } from '../src/lib/state.ts';
import { checkSchedule, passedToday, whenText } from '../src/lib/schedule.ts';
import { deltaText, explainCode, mergeEvents, stepOf } from '../src/lib/timeline.ts';
import {
  WAKE_GIVE_UP_MS,
  WAKE_KEEP_MS,
  WAKE_RETRY_MS,
  healthIsUp,
  nextWake,
} from '../src/lib/wake.ts';
import type { LogEntry, OwnerLimits, PublicConfig, RunEvent } from '../src/lib/types.ts';

const CONFIG: PublicConfig = {
  mode: 'live',
  networks: { ens: 'sepolia', hedera: 'testnet', x402: 'hedera:testnet', zg: 'testnet' },
  ensParent: 'chirag126.eth',
  payer: '0.0.11044318',
  policy: {
    asset: '0.0.0',
    maxPerPayment: '1000000',
    maxPerRun: '3000000',
    maxPerDay: '10000000',
    maxPaymentsPerRun: 10,
    maxSnapshotAgeSec: 600,
    allowedProviders: null,
    blockedProviders: [],
    allowedCapabilities: null,
    paymentsPaused: false,
    source: 'env',
    version: null,
  },
  hcs: null,
  zg: {
    model: 'm',
    capNeuron: '5000000000000000',
    dailyCapNeuron: '10000000000000000',
    planTokens: 768,
    analyzeTokens: 1024,
    maxPurchases: 3,
  },
};

describe('format', () => {
  it('converts tinybars and neuron exactly', () => {
    assert.equal(hbar('100000'), '0.001');
    assert.equal(hbar('270000'), '0.0027');
    assert.equal(hbar('100000000'), '1');
    assert.equal(hbar('123456789'), '1.23456789');
    assert.equal(hbar(0n), '0');
    assert.equal(zg('1326974000000000'), '0.001326974');
    assert.equal(zg('10000000000000000'), '0.01');
    assert.equal(grouped('12004338'), '12,004,338');
  });

  it('shows a 0G bill too small for 9 decimals in neuron, never "0 0G" (D-083)', () => {
    assert.equal(zgAmount('79'), '79 neuron');
    assert.equal(zgAmount('999999999'), '999,999,999 neuron');
    assert.equal(zgAmount('1000000000'), '0.000000001 0G');
    assert.equal(zgAmount('1326974000000000'), '0.001326974 0G');
    assert.equal(zgAmount('0'), '0 0G');
  });

  it('names 0G mainnet in the status bar instead of "Live on testnets" (D-083)', () => {
    assert.equal(liveNetworksLabel({ hedera: 'testnet', zg: 'testnet' }), 'Live on testnets');
    assert.equal(
      liveNetworksLabel({ hedera: 'testnet', zg: 'mainnet' }),
      'Live: 0G mainnet, Hedera and ENS testnets',
    );
  });

  it('parses HBAR typed by a person into tinybars, refusing anything else', () => {
    assert.equal(parseHbar('0.003'), 300_000n);
    assert.equal(parseHbar(' 1,5 '), 150_000_000n);
    assert.equal(parseHbar('2'), 200_000_000n);
    for (const bad of ['', '-1', '1e3', '0.123456789', 'abc', '1.2.3'])
      assert.equal(parseHbar(bad), null, bad);
  });

  it('shortens long IDs, formats UTC time and percentages', () => {
    assert.equal(middle('0x1993BB58708a630AF1CC01304Dd851BDEccF9261'), '0x1993BB58…EccF9261');
    assert.equal(middle('short'), 'short');
    assert.equal(utcTime('2026-10-27T15:07:29.839Z'), '27 Oct, 15:07:29 UTC');
    assert.equal(percentOf('270000', '300000'), 90);
    assert.equal(percentOf('5', '0'), null);
    assert.equal(percentOf('500', '100'), 100);
  });

  it('explorer links are https on fixed hosts and refuse junk', () => {
    assert.equal(
      hashscanTransaction('testnet', '0.0.7162784@1793113618.672975790'),
      'https://hashscan.io/testnet/transaction/0.0.7162784%401793113618.672975790',
    );
    assert.equal(
      etherscanAddress('0x1993BB58708a630AF1CC01304Dd851BDEccF9261'),
      'https://sepolia.etherscan.io/address/0x1993BB58708a630AF1CC01304Dd851BDEccF9261',
    );
    assert.equal(etherscanAddress('javascript:alert(1)'), null);
    assert.equal(etherscanBlock('12005898'), 'https://sepolia.etherscan.io/block/12005898');
    assert.equal(etherscanBlock('1; drop'), null);
    assert.equal(
      hashscanTopic('testnet', '0.0.7123456'),
      'https://hashscan.io/testnet/topic/0.0.7123456',
    );
    assert.equal(hashscanTopic('testnet', '0.0.1/../x'), null);
  });

  it('safeHref keeps only https links from the API', () => {
    const tx = 'https://hashscan.io/testnet/transaction/0.0.1-1-1';
    assert.equal(safeHref(tx), tx);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'http://hashscan.io/x',
      ' https://x',
      'https://a b',
      null,
      undefined,
    ])
      assert.equal(safeHref(bad), null, String(bad));
  });
});

describe('policy', () => {
  it('accepts a budget up to the configured run budget, in HBAR', () => {
    assert.deepEqual(checkBudget('0.003', CONFIG), { ok: true, tinybars: 300_000n });
    const over = checkBudget('0.05', CONFIG);
    assert.ok(!over.ok && /0.03 HBAR/.test(over.message));
    assert.ok(!checkBudget('0', CONFIG).ok);
    assert.ok(!checkBudget('lots', CONFIG).ok);
    const paused = checkBudget('0.003', {
      ...CONFIG,
      policy: { ...CONFIG.policy, paymentsPaused: true },
    });
    assert.ok(!paused.ok && /paused/.test(paused.message));
  });

  it('states the rules in sentences, with the task budget lowering the per-payment limit', () => {
    const rules = ruleSentences(CONFIG, 300_000n);
    assert.equal(rules[0], 'This task may spend at most 0.003 HBAR in total.');
    assert.equal(rules[1], 'No single payment may be more than 0.003 HBAR.');
    assert.match(rules[2] ?? '', /0.1 HBAR per UTC day/);
    assert.ok(rules.some((r) => r.includes('10 minutes')));
  });
});

const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): RunEvent => ({
  runId: 'r',
  seq,
  type,
  payload,
  at: '2026-10-27T15:07:00.000Z',
});

describe('timeline', () => {
  it('says 0G was not called when the paid data had no advisories (D-083)', () => {
    const empty = stepOf(ev(9, 'ANALYSIS_COMPLETED', { accepted: true, items: 0, note: 'x' }));
    assert.equal(empty.tone, 'warn');
    assert.equal(empty.title, 'No advisories to analyse');
    const real = stepOf(
      ev(9, 'ANALYSIS_COMPLETED', { accepted: true, items: 4, assessments: 2, p1: ['a'] }),
    );
    assert.equal(real.title, 'Analysis accepted: 2 assessed');
  });

  it('turns events into readable steps with their proofs', () => {
    const settled = stepOf(
      ev(8, 'PAYMENT_SETTLED', {
        transactionId: '0.0.7162784@1793113618.672975790',
        hashscan: 'https://hashscan.io/testnet/transaction/x',
      }),
    );
    assert.equal(settled.tone, 'good');
    assert.equal(settled.title, 'Payment settled and verified on Hedera');
    assert.deepEqual(settled.proofs, [
      {
        kind: 'tx',
        value: '0.0.7162784@1793113618.672975790',
        href: 'https://hashscan.io/testnet/transaction/x',
      },
    ]);
    const found = stepOf(
      ev(1, 'PROVIDERS_DISCOVERED', {
        parent: 'chirag126.eth',
        blockNumber: '12005898',
        providers: [{}, {}, {}],
      }),
    );
    assert.equal(found.title, 'Found 3 providers on ENS');
    const none = stepOf(
      ev(1, 'PROVIDERS_DISCOVERED', {
        parent: 'chirag126.eth',
        blockNumber: '12010000',
        providers: [],
        skipped: [{ label: 'kev', code: 'NOT_PURCHASABLE', reason: 'loopback http endpoint' }],
      }),
    );
    assert.equal(none.tone, 'bad');
    assert.match(none.detail ?? '', /kev skipped: loopback http endpoint/);
    assert.deepEqual(found.proofs, [{ kind: 'ens-block', value: '12005898' }]);
    const plan = stepOf(
      ev(5, 'INFERENCE_CALLED', {
        purpose: 'PLAN',
        status: 'SUCCEEDED',
        costNeuron: '1326974000000000',
        requestId: 'req-1',
        teeVerified: true,
      }),
    );
    assert.equal(plan.title, '0G planned the purchases');
    assert.equal(plan.detail, '0.001326974 0G, TEE signature verified');
    const refused = stepOf(
      ev(13, 'PAYMENT_REFUSED', { provider: 'kev.chirag126.eth', code: 'OVER_RUN_BUDGET' }),
    );
    assert.equal(refused.title, 'Firewall refused kev');
    assert.equal(refused.detail, "it would go over this task's budget");
    assert.equal(stepOf(ev(3, 'SOMETHING_NEW')).title, 'something new');
  });

  it('explains codes, including prefixed ones, and never shows an empty reason', () => {
    assert.equal(
      explainCode('NET_ADDRESS_BLOCKED'),
      'its address is not a public internet address',
    );
    assert.equal(explainCode('NET_SOMETHING_ODD'), 'something odd');
    assert.equal(explainCode('OUTPUT_SCHEMA_INVALID'), 'the data did not have the expected shape');
    assert.equal(explainCode(undefined), 'no reason was given');
  });

  it('merges stream events by sequence number, without duplicates, in order', () => {
    const merged = mergeEvents([ev(0, 'A'), ev(2, 'C')], [ev(1, 'B'), ev(2, 'C'), ev(3, 'D')]);
    assert.deepEqual(
      merged.map((e) => e.seq),
      [0, 1, 2, 3],
    );
  });
});

describe('markdown', () => {
  it('reads the brief: headings, paragraphs, lists, tables, bold, code and https links only', () => {
    const blocks = parseMarkdown(
      [
        '# Threat brief · 2026-10-27',
        '',
        '**Watchlist:** OpenSSL, lodash',
        '',
        '| Provider | Transaction |',
        '| --- | --- |',
        '| osv | [0.0.7@1](https://hashscan.io/testnet/transaction/x) |',
        '| a\\|b | `code` |',
        '',
        '- kev: `OVER_RUN_BUDGET`',
        '- [bad](javascript:alert(1))',
      ].join('\n'),
    );
    assert.deepEqual(
      blocks.map((b) => b.t),
      ['heading', 'paragraph', 'table', 'list'],
    );
    const table = blocks[2];
    assert.ok(table?.t === 'table');
    assert.deepEqual(table.rows[0]?.[1], [
      { t: 'link', v: '0.0.7@1', href: 'https://hashscan.io/testnet/transaction/x' },
    ]);
    assert.deepEqual(table.rows[1]?.[0], [{ t: 'text', v: 'a|b' }]);
    const list = blocks[3];
    assert.ok(list?.t === 'list');
    assert.deepEqual(list.items[1], [{ t: 'text', v: '[bad](javascript:alert(1))' }], 'not a link');
    assert.deepEqual(parseInline('**x** and `y`'), [
      { t: 'bold', v: 'x' },
      { t: 'text', v: ' and ' },
      { t: 'code', v: 'y' },
    ]);
  });
});

describe('API error messages', () => {
  it('are plain and actionable', () => {
    assert.match(describeApiError('UNREACHABLE', 0, null), /pnpm api:start/);
    assert.equal(describeApiError('ACCESS_DENIED', 401, null), 'That access code is not right.');
    assert.match(describeApiError('RATE_LIMITED', 429, 42), /42 s/);
    assert.match(describeApiError('SOMETHING', 500, null), /internal error/);
  });
});

const CEILING: OwnerLimits = {
  maxPerPayment: '1000000',
  maxPerRun: '3000000',
  maxPerDay: '10000000',
  maxPaymentsPerRun: 10,
  paymentsPaused: false,
  approvalMode: 'autonomous',
  approvalAboveTinybars: '0',
  providerDailyCaps: {},
};

describe('policy editor', () => {
  it('a draft from the limits in force round-trips', () => {
    const r = checkDraft(draftOf(CEILING), CEILING);
    assert.ok(r.ok);
    assert.deepEqual(r.limits, CEILING);
  });

  it('flags values above the server ceiling, out of order or malformed, per field', () => {
    const r = checkDraft(
      {
        maxPerPayment: '0.02',
        maxPerRun: '0.5',
        maxPerDay: '0.1',
        maxPaymentsPerRun: '0',
        paymentsPaused: false,
        approvalMode: 'autonomous',
        approvalAbove: '0',
        caps: [],
      },
      CEILING,
    );
    assert.ok(!r.ok);
    assert.match(r.errors.maxPerRun ?? '', /at most 0.03 HBAR per task/);
    assert.match(r.errors.maxPerPayment ?? '', /at most 0.01 HBAR per payment/);
    assert.match(r.errors.maxPaymentsPerRun ?? '', /1 or more/);
    const order = checkDraft(
      { ...draftOf(CEILING), maxPerPayment: '0.01', maxPerRun: '0.005' },
      CEILING,
    );
    assert.ok(!order.ok);
    assert.match(order.errors.maxPerPayment ?? '', /per-task limit/);
    assert.ok(!checkDraft({ ...draftOf(CEILING), maxPerDay: 'lots' }, CEILING).ok);
  });

  it('explains each change and what it does', () => {
    const lower = { ...CEILING, maxPerRun: '500000' };
    const [c] = policyChanges(CEILING, lower);
    assert.equal(c?.label, 'Per task');
    assert.equal(c?.from, '0.03 HBAR');
    assert.equal(c?.to, '0.005 HBAR');
    assert.match(c?.effect ?? '', /^Tighter/);
    assert.match(c?.effect ?? '', /already running/);
    const pause = policyChanges(CEILING, { ...CEILING, paymentsPaused: true });
    assert.match(pause[0]?.effect ?? '', /refuses every payment/);
    assert.deepEqual(policyChanges(CEILING, CEILING), []);
  });
});

const entry = (id: number): LogEntry => ({
  id,
  runId: 'r',
  seq: id,
  type: 'RUN_STARTED',
  stage: null,
  severity: 'info',
  at: '2026-10-27T15:07:00.000Z',
  payload: {},
});

describe('activity log paging', () => {
  it('merges pages newest first without duplicates', () => {
    const merged = mergeEntries([entry(5), entry(4)], [entry(6), entry(5), entry(3)]);
    assert.deepEqual(
      merged.map((e) => e.id),
      [6, 5, 4, 3],
    );
  });

  it('"Show 10 more" reveals loaded entries first and fetches only when needed', () => {
    assert.equal(moreAction({ visible: 10, next: 7 }, 25), 'reveal');
    assert.equal(moreAction({ visible: 10, next: 7 }, 12), 'fetch');
    assert.equal(moreAction({ visible: 10, next: null }, 14), 'reveal');
    assert.equal(moreAction({ visible: 20, next: null }, 14), 'none');
  });
});

describe('agent state and verdict words', () => {
  it('only states the server can be in, from its health and policy', () => {
    const base = { reachable: true, running: null, pending: 0, paymentsPaused: false };
    assert.equal(agentState(base), 'idle');
    assert.equal(agentState({ ...base, running: 'r1' }), 'executing');
    assert.equal(agentState({ ...base, pending: 2 }), 'waiting');
    assert.equal(agentState({ ...base, paymentsPaused: true }), 'blocked');
    assert.equal(agentState({ ...base, reachable: false, paymentsPaused: true }), 'unreachable');
  });

  it('only an end-to-end verified run gets the good tone; mock and failed runs say so', () => {
    assert.equal(verdictTone('e2e-verified'), 'good');
    assert.equal(verdictTone('failed'), 'bad');
    assert.equal(verdictTone('mock'), 'neutral');
    assert.match(VERDICT_TEXT.mock, /not verification/);
    assert.match(VERDICT_TEXT.failed, /not verified/);
  });
});

describe('daily brief form', () => {
  it('checks the watchlist, the budget against the per-task limit and the UTC time', () => {
    const ok = checkSchedule(
      { watchlist: 'OpenSSL\nlodash, OpenSSL', budget: '0.003', runAfter: '00:15' },
      '3000000',
    );
    assert.ok(ok.ok);
    assert.deepEqual(ok.body, {
      watchlist: ['OpenSSL', 'lodash'],
      budget: '300000',
      runAfter: '00:15',
    });
    const bad = checkSchedule({ watchlist: ' ', budget: '1', runAfter: '24:00' }, '3000000');
    assert.ok(!bad.ok);
    assert.match(bad.errors.watchlist ?? '', /at least one/);
    assert.match(bad.errors.budget ?? '', /0.03 HBAR/);
    assert.match(bad.errors.runAfter ?? '', /HH:MM/);
  });

  it("states the time in UTC and in the viewer's time zone", () => {
    assert.equal(whenText('00:15', 0), 'Every day after 00:15 UTC');
    assert.equal(whenText('00:15', -330), 'Every day after 00:15 UTC (05:45 your time)');
    assert.equal(whenText('02:00', 300), 'Every day after 02:00 UTC (21:00 your time)');
  });

  it("summarises a brief's delta in the trail", () => {
    assert.equal(deltaText(null), null);
    assert.equal(
      deltaText({ added: ['A'], gone: [], changed: [{ id: 'B' }, { id: 'C' }] }),
      'Since the previous brief: 1 new, 0 no longer in the data, 2 priority changes.',
    );
  });
});

describe('daily brief: does saving start a brief now?', () => {
  it("only when today's UTC time has passed", () => {
    const at = new Date('2026-10-28T00:20:00.000Z');
    assert.equal(passedToday('00:15', at), true);
    assert.equal(passedToday('00:20', at), true);
    assert.equal(passedToday('00:21', at), false);
    assert.equal(passedToday('nope', at), false);
  });
});

describe('deployment (D-062)', () => {
  it('knows the hosts where the holder lane can sign in', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]']) assert.equal(isLocalhost(h), true, h);
    for (const h of ['agent.onrender.com', 'localhost.evil.example', '10.0.0.1'])
      assert.equal(isLocalhost(h), false, h);
  });
});

describe('spending controls (D-066)', () => {
  const HUMAN: OwnerLimits = {
    ...CEILING,
    approvalMode: 'human',
    approvalAboveTinybars: '200000',
    providerDailyCaps: { 'kev.chirag126.eth': '400000' },
  };

  it('a draft with approval and caps round-trips; autonomous is the default', () => {
    const r = checkDraft(draftOf(HUMAN), CEILING);
    assert.ok(r.ok);
    assert.deepEqual(r.limits, HUMAN);
    assert.ok(sameLimits(r.limits, HUMAN));
    // an older server sends none of the new fields: autonomous, no caps
    const old: OwnerLimits = {
      maxPerPayment: '1',
      maxPerRun: '1',
      maxPerDay: '1',
      maxPaymentsPerRun: 1,
      paymentsPaused: false,
    };
    assert.equal(draftOf(old).approvalMode, 'autonomous');
    assert.deepEqual(draftOf(old).caps, []);
    assert.ok(sameLimits(old, { ...old, approvalMode: 'autonomous', providerDailyCaps: {} }));
  });

  it('dirty only when something changed', () => {
    const d = draftOf(HUMAN);
    assert.equal(draftDirty(d, d), false);
    assert.equal(draftDirty({ ...d, approvalMode: 'autonomous' }, d), true);
    assert.equal(draftDirty({ ...d, caps: [] }, d), true);
    assert.equal(
      draftDirty({ ...d, caps: [{ name: ' KEV.chirag126.eth ', amount: '0.004' }] }, d),
      false,
    );
  });

  it('flags bad thresholds and caps per row', () => {
    const base = draftOf(CEILING);
    const r = checkDraft(
      {
        ...base,
        approvalAbove: '-1',
        caps: [
          { name: 'not a name', amount: '0.001' },
          { name: 'kev.x.eth', amount: '0' },
          { name: 'cve.x.eth', amount: '0.2' },
          { name: 'osv.x.eth', amount: '0.001' },
          { name: 'OSV.x.eth', amount: '0.001' },
        ],
      },
      CEILING,
    );
    assert.ok(!r.ok);
    assert.ok(r.errors.approvalAbove !== undefined);
    assert.match(r.errors['cap-0'] ?? '', /ENS name/);
    assert.match(r.errors['cap-1'] ?? '', /more than zero/);
    assert.match(r.errors['cap-2'] ?? '', /daily limit/);
    assert.equal(r.errors['cap-3'], undefined);
    assert.match(r.errors['cap-4'] ?? '', /already has a cap/);
  });

  it('explains switching modes, the threshold and caps', () => {
    const on = policyChanges(CEILING, HUMAN);
    assert.deepEqual(
      on.map((c) => c.field),
      ['approvalMode', 'providerDailyCaps'],
    );
    assert.match(on[0]?.effect ?? '', /wait for your approval/);
    assert.match(on[1]?.effect ?? '', /OVER_PROVIDER_DAILY_BUDGET/);
    const threshold = policyChanges(HUMAN, { ...HUMAN, approvalAboveTinybars: '0' });
    assert.equal(threshold[0]?.to, 'every payment');
    const off = policyChanges(HUMAN, {
      ...HUMAN,
      approvalMode: 'autonomous',
      providerDailyCaps: {},
    });
    assert.equal(off[0]?.to, 'Autonomous');
    assert.equal(off[1]?.to, 'No cap');
  });

  it('the rules list the caps and the mode in force', () => {
    const config = {
      policy: {
        ...CEILING,
        maxSnapshotAgeSec: 600,
        allowedProviders: null,
        blockedProviders: [],
        approvalMode: 'human',
        approvalAboveTinybars: '0',
        providerDailyCaps: { 'kev.x.eth': '100000' },
      },
    } as unknown as PublicConfig;
    const text = ruleSentences(config, null).join(' ');
    assert.match(text, /0\.001 HBAR per UTC day to kev\.x\.eth/);
    assert.match(text, /every payment waits for the owner/);
  });

  it('the agent waits for approval only while a task runs', () => {
    const base = { reachable: true, running: 'r1', pending: 0, paymentsPaused: false };
    assert.equal(agentState({ ...base, approvalsPending: 1 }), 'approval');
    assert.equal(agentState({ ...base, approvalsPending: 0 }), 'executing');
    assert.equal(agentState({ ...base, running: null, approvalsPending: 1 }), 'idle');
  });

  it('timeline steps for approval events say what happened, without inventing', () => {
    const ev = (type: string, payload: Record<string, unknown>): RunEvent => ({
      runId: 'r',
      seq: 1,
      type,
      payload,
      at: '2026-10-29T10:00:00.000Z',
    });
    const asked = stepOf(
      ev('PAYMENT_APPROVAL_REQUESTED', {
        provider: 'kev.x.eth',
        amountAtomic: '100000',
        payTo: '0.0.11044329',
        expiresAt: '2026-10-29T10:10:00.000Z',
      }),
    );
    assert.equal(asked.tone, 'warn');
    assert.match(asked.title, /0\.001 HBAR to kev/);
    assert.match(asked.detail ?? '', /10:10 UTC/);
    assert.equal(stepOf(ev('PAYMENT_APPROVAL_DECIDED', { decision: 'APPROVED' })).tone, 'good');
    assert.match(
      stepOf(ev('PAYMENT_APPROVAL_DECIDED', { decision: 'EXPIRED', decidedBy: 'restart' }))
        .detail ?? '',
      /restarted/,
    );
    for (const code of ['APPROVAL_REJECTED', 'OVER_PROVIDER_DAILY_BUDGET', 'SELF_PROVIDER'])
      assert.doesNotMatch(explainCode(code), /_/, code);
  });

  it('the countdown comes from the request’s expiry', () => {
    const now = Date.parse('2026-10-29T10:00:00.000Z');
    assert.equal(secondsLeft('2026-10-29T10:04:05.000Z', now), 245);
    assert.equal(secondsLeft('2026-10-29T09:59:00.000Z', now), 0);
    assert.equal(secondsLeft('garbage', now), 0);
    assert.equal(countdownText(245), '4 min 05 s');
    assert.equal(countdownText(35), '35 s');
  });

  it('ERC-8004 token links are built only from valid IDs', () => {
    assert.equal(
      etherscanToken('0x8004A818BFB912233c491871b3d84c89A494BD9e', '12'),
      'https://sepolia.etherscan.io/token/0x8004A818BFB912233c491871b3d84c89A494BD9e?a=12',
    );
    assert.equal(etherscanToken('0x8004', '12'), null);
    assert.equal(etherscanToken('0x8004A818BFB912233c491871b3d84c89A494BD9e', '1; drop'), null);
  });
});

describe('UI theme (Phase UI toggle)', () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => data.get(k) ?? null,
      removeItem: (k: string) => void data.delete(k),
      data,
    };
  };
  const throwing = {
    getItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };

  it('Classic is the default; unknown names are Classic', () => {
    assert.equal(DEFAULT_THEME, 'classic');
    assert.equal(parseTheme(undefined), 'classic');
    assert.equal(parseTheme('neon'), 'classic');
    assert.equal(parseTheme('electric'), 'electric');
    assert.equal(parseTheme('enderpay'), 'enderpay');
    assert.equal(parseTheme('EnderPay'), 'classic');
    assert.deepEqual([...THEMES], ['classic', 'electric', 'enderpay']);
  });

  it('nothing is remembered: an old saved choice is removed, a refusing browser is fine (D-075)', () => {
    const s = store({ [THEME_STORAGE_KEY]: 'enderpay', other: 'kept' });
    assert.equal(forgetSavedTheme(s), true);
    assert.deepEqual([...s.data.keys()], ['other']);
    assert.equal(forgetSavedTheme(s), false);
    assert.equal(forgetSavedTheme(throwing), false);
    assert.equal(forgetSavedTheme(null), false);
  });

  it('switching notifies listeners without a page or React reload', () => {
    let calls = 0;
    const off = onThemeChange(() => calls++);
    setTheme('electric');
    assert.equal(currentTheme(), 'electric');
    setTheme('classic');
    off();
    setTheme('electric');
    assert.equal(calls, 2);
    setTheme('classic');
  });
});

describe('EnderPay audio (commit 2, D-072)', () => {
  it('every tab has the owner’s track; other pages get Wet Hands', () => {
    const t = (route: string[]) => trackForRoute(route).title;
    assert.equal(t([]), 'Minecraft');
    assert.equal(t(['new']), 'Aria Math');
    assert.equal(t(['schedule']), 'Mice on Venus');
    assert.equal(t(['evidence']), 'Moog City 2');
    assert.equal(t(['logs']), 'Subwoofer Lullaby');
    assert.equal(t(['payments']), 'Haggstrom');
    assert.equal(t(['approvals']), 'Sweden');
    assert.equal(t(['usage']), 'Excuse');
    assert.equal(t(['providers']), 'Dry Hands');
    assert.equal(t(['rules']), 'Key');
    assert.equal(t(['holder']), 'Living Mice');
    assert.equal(t(['tasks', 'abc']), 'Wet Hands');
    assert.equal(t(['nowhere']), 'Wet Hands');
    assert.equal(trackUrl(trackForRoute(['approvals'])), '/audio/music/sweden.mp3');
    assert.equal(new Set(Object.values(TAB_TRACKS).map((x) => x.file)).size, 11);
  });

  it('music and click sounds are independent preferences, stored locally, safe on bad input', () => {
    assert.deepEqual(DEFAULT_AUDIO, { music: true, sfx: true, volume: 0.35 });
    assert.deepEqual(parseAudioPrefs(null), DEFAULT_AUDIO);
    assert.deepEqual(parseAudioPrefs('{nope'), DEFAULT_AUDIO);
    assert.deepEqual(parseAudioPrefs('{"music":false,"sfx":true,"volume":2}'), {
      music: false,
      sfx: true,
      volume: 1,
    });
    assert.deepEqual(parseAudioPrefs('{"music":true,"sfx":false}'), {
      music: true,
      sfx: false,
      volume: 0.35,
    });
    const data = new Map<string, string>();
    const s = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
    assert.equal(writeAudioPrefs(s, { music: false, sfx: true, volume: 0.5 }), true);
    assert.deepEqual(readAudioPrefs(s), { music: false, sfx: true, volume: 0.5 });
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    assert.deepEqual(readAudioPrefs(throwing), DEFAULT_AUDIO);
    assert.equal(writeAudioPrefs(throwing, DEFAULT_AUDIO), false);
  });

  it('the status text never claims playback that did not happen', () => {
    const sweden = trackForRoute(['approvals']);
    assert.equal(musicStatusText('playing', sweden), 'Playing Sweden (C418)');
    assert.match(musicStatusText('blocked', sweden), /blocked autoplay: click anywhere/);
    assert.match(musicStatusText('missing', sweden), /not installed .*\/audio\/music\/sweden\.mp3/);
    assert.equal(musicStatusText('off', sweden), 'Music is off');
  });

  it('owner-set start positions; every other track starts at 0 (D-074)', () => {
    const start = (route: string[]) => trackForRoute(route).startSec;
    assert.equal(start([]), 12); // Minecraft 00:12
    assert.equal(start(['schedule']), 30); // Mice on Venus 00:30
    assert.equal(start(['new']), 150); // Aria Math 02:30
    assert.equal(start(['rules']), 6); // Key 00:06
    const others = ['evidence', 'logs', 'payments', 'approvals', 'usage', 'providers', 'holder'];
    for (const tab of others) assert.equal(start([tab]), 0, tab);
    assert.equal(start(['tasks', 'abc']), 0);
  });

  it('the end fade is a smooth line to silence over the last 4.5 s (D-074)', () => {
    assert.equal(END_FADE_SEC, 4.5);
    assert.equal(RESTART_GAP_MS, 2000);
    assert.equal(endFadeGain(0, 100), 1);
    assert.equal(endFadeGain(95.5, 100), 1);
    assert.equal(endFadeGain(97.75, 100), 0.5);
    assert.equal(endFadeGain(100, 100), 0);
    assert.equal(endFadeGain(101, 100), 0);
    // unknown length (still loading, a stream): no fade
    assert.equal(endFadeGain(3, Number.NaN), 1);
    assert.equal(endFadeGain(3, Infinity), 1);
    assert.equal(endFadeGain(3, 0), 1);
    // strictly decreasing through the fade
    let last = 2;
    for (let t = 95.5; t <= 100; t += 0.05) {
      const g = endFadeGain(t, 100);
      assert.ok(g <= last);
      last = g;
    }
  });

  it('fades never change the chosen volume; a repeat is back at it (D-074)', () => {
    assert.equal(playbackVolume(1, 1, 1), 1);
    assert.equal(playbackVolume(0.6, 1, 0.5), 0.3);
    assert.equal(playbackVolume(0.6, 0, 1), 0);
    // after the fade, the same chosen volume with fades back at 1 is the full level again
    assert.equal(playbackVolume(0.6, 1, endFadeGain(12, 200)), 0.6);
    assert.equal(playbackVolume(2, 1, 1), 1);
    assert.equal(playbackVolume(Number.NaN, 1, 1), 0);
  });

  it('each nav tab is its own music tab; all other pages share one (D-074)', () => {
    assert.equal(tabForRoute([]), '');
    assert.equal(tabForRoute(['logs']), 'logs');
    assert.equal(tabForRoute(['evidence', 'x']), 'evidence');
    assert.equal(tabForRoute(['tasks', 'abc']), '*');
    assert.equal(tabForRoute(['nowhere']), '*');
    assert.equal(tabForRoute(['constructor']), '*');
  });

  it('the repeat status says what is about to happen', () => {
    assert.equal(
      musicStatusText('repeat', trackForRoute(['logs'])),
      'Subwoofer Lullaby (C418) finished: playing it again in 2 s',
    );
  });

  it('click sounds only for real, enabled controls', () => {
    const base = {
      tag: 'button',
      role: null,
      type: null,
      disabled: false,
      ariaDisabled: false,
      hasHref: false,
      classes: [] as string[],
    };
    assert.equal(isSoundTarget(base), true);
    assert.equal(isSoundTarget({ ...base, disabled: true }), false);
    assert.equal(isSoundTarget({ ...base, ariaDisabled: true }), false);
    assert.equal(
      isSoundTarget({ ...base, tag: 'a', hasHref: true, classes: ['is-disabled'] }),
      false,
    );
    assert.equal(isSoundTarget({ ...base, tag: 'a', hasHref: true }), true);
    assert.equal(isSoundTarget({ ...base, tag: 'a' }), false);
    assert.equal(isSoundTarget({ ...base, tag: 'summary' }), true);
    assert.equal(isSoundTarget({ ...base, tag: 'input', type: 'radio' }), true);
    assert.equal(isSoundTarget({ ...base, tag: 'input', type: 'text' }), false);
    assert.equal(isSoundTarget({ ...base, tag: 'input', type: 'range' }), false);
    assert.equal(isSoundTarget({ ...base, tag: 'div' }), false);
    assert.equal(isSoundTarget({ ...base, tag: 'div', role: 'button' }), true);
  });
});

describe('EnderPay click onset (fix after the owner’s report)', () => {
  it('finds where the click starts, in any channel, with a small lead', () => {
    const rate = 1000;
    const quiet = new Float32Array(1000);
    const loud = new Float32Array(1000);
    loud[600] = 0.5;
    assert.equal(firstAudible([quiet, loud], rate), 0.6 - 0.005);
    const early = new Float32Array(1000);
    early[2] = -0.3;
    assert.equal(firstAudible([early], rate), 0);
    assert.equal(firstAudible([quiet], rate), 0);
    const noise = new Float32Array(1000).fill(0.01);
    assert.equal(firstAudible([noise], rate), 0);
  });
});

describe('voice task (D-076)', () => {
  it('a spoken list becomes one item per line; versions survive', () => {
    assert.equal(
      spokenToWatchlist('OpenSSL, lodash 4.17.21 and nginx.'),
      'OpenSSL\nlodash 4.17.21\nnginx',
    );
    assert.equal(
      spokenToWatchlist('Microsoft Windows; Apache Struts. openssl, OpenSSL'),
      'Microsoft Windows\nApache Struts\nopenssl',
    );
    assert.equal(spokenToWatchlist('  "Log4j version 2.17.1!"  '), 'Log4j version 2.17.1');
    assert.equal(spokenToWatchlist(''), '');
    assert.equal(spokenToWatchlist('. , and'), '');
  });

  it('recording format: the first the browser supports; files map to accepted types', () => {
    assert.equal(
      pickRecordingType(() => true),
      'audio/webm;codecs=opus',
    );
    assert.equal(
      pickRecordingType((t) => t === 'audio/mp4'),
      'audio/mp4',
    );
    assert.equal(
      pickRecordingType(() => false),
      null,
    );
    assert.equal(clipType('audio/mpeg'), 'audio/mpeg');
    assert.equal(clipType('audio/mp3'), 'audio/mpeg');
    assert.equal(clipType('audio/x-m4a'), 'audio/mp4');
    assert.equal(clipType('audio/webm;codecs=opus'), 'audio/webm');
    assert.equal(clipType('video/mp4'), null);
    assert.equal(clipType(''), null);
    assert.equal(MAX_RECORD_SEC, 30);
  });

  it('the receipt says only what the ledger row says', () => {
    const base = {
      id: 'c1',
      runId: null,
      purpose: 'TRANSCRIBE',
      network: 'testnet',
      model: 'whisper-large-v3',
      promptTokens: 0,
      completionTokens: 0,
      worstCaseNeuron: '1000000000000000',
      funding: 'unknown',
      errorCode: null,
      createdAt: '2026-10-31T00:00:00.000Z',
    };
    const ok = voiceReceipt({
      ...base,
      status: 'SUCCEEDED',
      requestId: 'r1',
      costNeuron: '120000000000000',
      teeVerified: true,
    });
    assert.equal(ok.tone, 'good');
    assert.match(ok.detail, /0\.00012 0G, TEE signature verified/);
    const unknown = voiceReceipt({
      ...base,
      status: 'UNKNOWN',
      requestId: null,
      costNeuron: null,
      teeVerified: null,
      errorCode: 'NO_BILLING_TRACE',
    });
    assert.equal(unknown.tone, 'warn');
    assert.match(unknown.detail, /without a request ID or bill/);
    assert.match(unknown.detail, /0\.001 0G/);
  });
});

describe('provider host wake from the browser (D-085)', () => {
  it('counts only a 200 with status ok as up', () => {
    assert.equal(healthIsUp(200, { status: 'ok', providers: ['kev'] }), true);
    assert.equal(healthIsUp(429, { status: 'ok' }), false);
    assert.equal(healthIsUp(200, { status: 'starting' }), false);
    assert.equal(healthIsUp(200, null), false);
  });

  it('asks every 10 s while waking, gives up after 3 min, and keeps an up host awake every 5 min', () => {
    assert.deepEqual(nextWake(true, 0), { state: 'ready', againMs: WAKE_KEEP_MS });
    assert.deepEqual(nextWake(false, 0), { state: 'waking', againMs: WAKE_RETRY_MS });
    assert.deepEqual(nextWake(false, WAKE_GIVE_UP_MS - WAKE_RETRY_MS), {
      state: 'waking',
      againMs: WAKE_RETRY_MS,
    });
    assert.deepEqual(nextWake(false, WAKE_GIVE_UP_MS), {
      state: 'unreachable',
      againMs: WAKE_KEEP_MS,
    });
    assert.ok(WAKE_KEEP_MS < 15 * 60_000, 'inside Render free 15-minute idle window');
  });
});

describe('HCS audit on a finished task page (D-086)', () => {
  it('keeps asking until the digest is recorded and nothing is still being submitted', () => {
    const settled = { kind: 'settlement', status: 'CONFIRMED' };
    assert.equal(auditSettling([], true), true, 'posted after the run ends: not there yet');
    assert.equal(auditSettling([{ kind: 'settlement', status: 'SUBMITTING' }], true), true);
    assert.equal(auditSettling([settled, { kind: 'task', status: 'SUBMITTED' }], true), true);
    assert.equal(auditSettling([settled, { kind: 'task', status: 'CONFIRMED' }], true), false);
    // UNKNOWN is decided by the server's reconcile, not by asking again
    assert.equal(auditSettling([settled, { kind: 'task', status: 'UNKNOWN' }], true), false);
    assert.equal(auditSettling([], false), false, 'no HCS topic: nothing to wait for');
  });
});

describe('daily activity charts (D-089)', () => {
  const now = new Date('2026-11-06T10:00:00Z');

  it('lists the last UTC days, oldest first', () => {
    assert.deepEqual(lastUtcDays(3, now), ['2026-11-04', '2026-11-05', '2026-11-06']);
    assert.equal(dayLabel('2026-11-06'), 'Nov 6');
    // the charts end on the server's UTC day, not the browser's clock
    assert.deepEqual(lastUtcDays(2, dayStart('2026-10-27')), ['2026-10-26', '2026-10-27']);
  });

  it('totals only real rows, per day and per key; other days and keys are ignored', () => {
    const days = lastUtcDays(2, now);
    const rows = [
      { at: '2026-11-06T01:00:00Z', k: 'SETTLED', v: 120000n },
      { at: '2026-11-06T02:00:00Z', k: 'SETTLED', v: 100000n },
      { at: '2026-11-05T23:59:59Z', k: 'SETTLED', v: 5n },
      { at: '2026-11-06T03:00:00Z', k: 'REFUSED', v: 999n },
      { at: '2026-10-01T00:00:00Z', k: 'SETTLED', v: 7n },
    ];
    const cols = byDay(
      rows,
      days,
      ['SETTLED'],
      (r) => r.at,
      (r) => r.k,
      (r) => r.v,
    );
    assert.deepEqual(
      cols.map((c) => [c.day, c.total]),
      [
        ['2026-11-05', 5n],
        ['2026-11-06', 220000n],
      ],
    );
  });

  it('a key mapped to null is not counted (running and mock runs)', () => {
    const cols = byDay(
      [{ v: 'in-progress' }, { v: 'failed' }],
      ['2026-11-06'],
      ['failed'],
      () => '2026-11-06T00:00:00Z',
      (r) => (r.v === 'failed' ? 'failed' : null),
      () => 1n,
    );
    assert.equal(cols[0]?.total, 1n);
  });

  it('bar heights are a share of the tallest day; no activity draws nothing', () => {
    assert.equal(share(5n, 10n), 50);
    assert.equal(share(10n, 10n), 100);
    assert.equal(share(0n, 10n), 0);
    assert.equal(share(3n, 0n), 0);
  });
});
