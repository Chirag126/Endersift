/**
 * Playwright smoke test of the web app (plan row 27), against the MOCK API
 * (fake ENS, payments and 0G behind the real API server). It checks the UI's
 * wiring and states, never the networks; the live check is manual (see
 * phasereadme.md, Phase 26).
 *
 *   pnpm web:build
 *   pnpm web:smoke                     (needs: pnpm exec playwright install chromium, once)
 *
 * Screenshots go to artifacts/web-smoke/ (not committed). Exit 0 only if
 * every step passes.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import type { Browser, BrowserType, Page } from 'playwright';
import { MOCK_ACCESS_CODE, startMockApi } from '../apps/server/test/support/mock-api.ts';
import { UsageError, handleScriptErrors } from './lib/cli.ts';

handleScriptErrors();

const DIST = resolve('apps/web/dist');
const SHOTS = resolve('artifacts/web-smoke');
if (!existsSync(join(DIST, 'index.html')))
  throw new UsageError('build the web app first: pnpm web:build');
mkdirSync(SHOTS, { recursive: true });

// loaded with require so the pre-installed copy is found where node_modules has none
const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: BrowserType };

// ── the app and /api from one server, as deployed (D-062): the API serves dist with its CSP ──
const api = await startMockApi(0, '127.0.0.1', { webRoot: DIST });
const base = api.url;

// ── steps ─────────────────────────────────────────────────────────────────
interface Result {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const results: Result[] = [];
// a fake microphone (a test tone), so the voice task records for real (D-076)
const browser: Browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 860 },
  permissions: ['microphone'],
});
const page: Page = await context.newPage();
const consoleErrors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = (await fn()) ?? '';
    results.push({ name, ok: true, detail });
    console.log(`OK   ${name}${detail === '' ? '' : ` (${detail})`}`);
  } catch (error) {
    const detail = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    results.push({ name, ok: false, detail });
    console.log(`FAIL ${name} (${detail})`);
    await page
      .screenshot({ path: join(SHOTS, `fail-${results.length}.png`), fullPage: true })
      .catch(() => {});
  }
}
const go = async (hash: string) => {
  await page.goto(`${base}/${hash}`);
  await page.waitForLoadState('networkidle');
};
const shot = (name: string) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
const visible = (text: string | RegExp) =>
  page.getByText(text).first().waitFor({ timeout: 10_000 });

console.log(`web smoke: app ${base} · MOCK API ${api.url}\n`);

await step(
  'overview: mock mode is labelled, no runs yet, empty activity, no old evidence',
  async () => {
    await go('#/');
    await page.getByRole('heading', { level: 1, name: 'Overview' }).waitFor();
    await visible('Mock data, nothing real is spent');
    await visible('Idle, ready');
    await visible('No runs yet.');
    // the activity charts show real rows only: nothing yet (D-089)
    await page.getByRole('heading', { name: 'Last 7 days' }).waitFor();
    await visible('No finished tasks this week.');
    await visible('No settled payments this week.');
    if ((await page.locator('.proven, .capabilities').count()) > 0)
      throw new Error('development evidence is still shown on the Overview');
    await shot('overview-empty');
  },
);

await step('providers: empty state before the first discovery', async () => {
  await go('#/providers');
  await visible('No providers discovered yet.');
});

await step('new task: a wrong access code is refused', async () => {
  await go('#/new');
  await page.getByLabel('Access code').fill('not-the-code');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await visible('That access code is not right.');
});

await step('new task: the right access code unlocks starting', async () => {
  await page.getByLabel('Access code').fill(MOCK_ACCESS_CODE);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.getByRole('button', { name: 'Start task' }).waitFor();
  if (await page.getByLabel('Access code').isVisible()) throw new Error('access form still shown');
});

await step('new task: a budget above the limit is refused before sending', async () => {
  await page.getByLabel('What should the agent watch?').fill('OpenSSL\nlodash@4.17.21 (npm)');
  await page.getByLabel('Budget for this task').fill('1');
  await visible('The most a task may spend is 0.03 HBAR');
  if (!(await page.getByRole('button', { name: 'Start task' }).isDisabled()))
    throw new Error('start button enabled with an invalid budget');
  await page.getByLabel('Budget for this task').fill('0.003');
  await visible('300000 tinybars');
  await shot('new-task');
});

let taskUrl = '';
await step('start a task and follow it live to the end', async () => {
  await page.getByRole('button', { name: 'Start task' }).click();
  await page.waitForURL(/#\/tasks\/[0-9a-f-]{36}$/);
  taskUrl = page.url();
  await page.getByText('Task finished').first().waitFor({ timeout: 30_000 });
  const steps = await page.locator('.trail > li').count();
  if (steps < 10) throw new Error(`only ${steps} trail steps`);
  await visible('Payment settled and verified on Hedera');
  return `${steps} steps`;
});

await step(
  'task page: stages, mock verdict, HashScan links, 0G request IDs and the brief',
  async () => {
    await page.locator('.run-summary .track-stage').nth(6).waitFor();
    const done = await page.locator('.run-summary .track-done').count();
    if (done !== 7) throw new Error(`${done} of 7 stages done`);
    await visible('Mock run, not verification');
    if ((await page.getByText('End-to-end verified').count()) > 0)
      throw new Error('a mock run is shown as end-to-end verified');
    const links = await page.locator('a[href^="https://hashscan.io/testnet/transaction/"]').count();
    if (links < 2) throw new Error(`${links} HashScan links`);
    await visible(/^5d2c1e0a-/);
    await page
      .locator('.brief h2')
      .filter({ hasText: 'Threat brief' })
      .waitFor({ timeout: 10_000 });
    await visible('Patch OpenSSL today (mock analysis).');
    // HCS audit (D-057): two settlements and a digest, confirmed on the (fake) Mirror Node
    await page.getByRole('heading', { name: 'HCS audit' }).waitFor();
    const onMirror = await page.getByText('On the Mirror Node', { exact: true }).count();
    if (onMirror !== 3) throw new Error(`${onMirror} audit messages on the Mirror Node`);
    await shot('task');
    return `${links} HashScan links`;
  },
);

await step('a finished task reloads from the record (replay, no stream)', async () => {
  await page.goto(taskUrl);
  await page.getByText('Complete').first().waitFor();
  await visible('Task finished');
});

await step('payments page lists both payments with transactions', async () => {
  await go('#/payments');
  await page.locator('table.payments tbody tr').first().waitFor();
  const settled = await page
    .locator('table.payments tbody tr')
    .filter({ hasText: 'Settled' })
    .count();
  if (settled !== 2) throw new Error(`${settled} settled rows`);
  await shot('payments');
});

await step('0G usage page shows the ledger', async () => {
  await go('#/usage');
  await visible('Analysis');
  await visible(/^5d2c1e0a-/);
  await shot('usage');
});

// ── the voice task (D-076): say the watchlist; 0G writes it down; the task links the call ──
const CLIP = {
  name: 'watchlist.webm',
  mimeType: 'audio/webm',
  buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]),
};
const voiceFile = () => page.locator('.voice-file input[type="file"]');

await step(
  'voice task: a clip is heard on 0G, fills the watchlist, and joins the task it starts',
  async () => {
    await go('#/new');
    await page.getByRole('button', { name: 'Say it' }).waitFor();
    await voiceFile().setInputFiles(CLIP);
    await page.locator('.voice-receipt').getByText('Heard on 0G', { exact: true }).waitFor();
    const filled = await page.getByLabel('What should the agent watch?').inputValue();
    if (filled !== 'OpenSSL\nlodash 4.17.21\nnginx')
      throw new Error(`watchlist: ${JSON.stringify(filled)}`);
    const id = (await page.locator('.voice-receipt .proof-id').getAttribute('title')) ?? '';
    if (!/a11ce0a0-/.test(id)) throw new Error(`receipt request ID: ${id}`);
    await page.getByLabel('Budget for this task').fill('0.003');
    await shot('voice-new-task');
    await page.getByRole('button', { name: 'Start task' }).click();
    await page.waitForURL(/#\/tasks\/[0-9a-f-]{36}$/);
    await page.getByText('Task finished').first().waitFor({ timeout: 30_000 });
    await visible('Voice watchlist');
    const ids = await page
      .locator('.side-list .proof-id')
      .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
    if (!ids.some((t) => t.includes(id.split(': ')[1] ?? 'none')))
      throw new Error(`the task does not list the voice call: ${ids.join(' | ')}`);
    await shot('voice-task');
    return 'clip → 0G transcript → watchlist → task with the TRANSCRIBE call';
  },
);

await step('voice task: recording from the microphone (fake device) goes to 0G too', async () => {
  await go('#/new');
  await page.getByRole('button', { name: 'Say it' }).click();
  await page.getByRole('button', { name: /^Stop/ }).waitFor();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /^Stop/ }).click();
  await page.locator('.voice-receipt').getByText('Heard on 0G', { exact: true }).waitFor();
  const id = (await page.locator('.voice-receipt .proof-id').getAttribute('title')) ?? '';
  if (!/a11ce0a0-0000-4000-8000-000000000002/.test(id)) throw new Error(`second call: ${id}`);
  // "Not from voice" detaches it: the task would start without the voice call
  await page.getByRole('button', { name: 'Not from voice' }).click();
  if ((await page.locator('.voice-receipt').count()) !== 0) throw new Error('receipt still shown');
  return 'MediaRecorder → POST /api/voice → transcript';
});

await step('voice and the 0G card render in Classic, Electric and EnderPay', async () => {
  const themes = ['Classic', 'Electric', 'EnderPay'] as const;
  for (const name of themes) {
    await go('#/');
    await page
      .getByRole('group', { name: 'Interface theme' })
      .getByRole('button', { name, exact: true })
      .click();
    await page.getByRole('heading', { name: 'Why 0G is the product here' }).waitFor();
    await visible(/Without 0G/);
    // the activity charts render in every theme (D-089); the mock harness dates its payments
    // 27 Oct, outside the server's week, so they honestly show the empty state here
    await page.getByRole('heading', { name: 'Last 7 days' }).waitFor();
    await page.locator('.day-chart').first().waitFor();
    if ((await page.locator('.day-chart-bars, .day-chart-empty').count()) < 2)
      throw new Error('an activity chart has neither bars nor an empty state');
    await shot(`zg-card-${name.toLowerCase()}`);
    await go('#/new');
    await voiceFile().setInputFiles(CLIP);
    await page.locator('.voice-receipt').getByText('Heard on 0G', { exact: true }).waitFor();
    const overflow = Number(
      await page.evaluate(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      ),
    );
    if (overflow > 1) throw new Error(`${name}: the page scrolls sideways by ${overflow}px`);
    await shot(`voice-${name.toLowerCase()}`);
  }
  // phone width, EnderPay (the widest controls)
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = Number(
    await page.evaluate(
      'document.documentElement.scrollWidth - document.documentElement.clientWidth',
    ),
  );
  await shot('voice-enderpay-phone');
  await page.setViewportSize({ width: 1280, height: 860 });
  if (phone > 1) throw new Error(`phone: sideways scroll ${phone}px`);
  await go('#/');
  await page
    .getByRole('group', { name: 'Interface theme' })
    .getByRole('button', { name: 'Classic', exact: true })
    .click();
  return `${themes.length} themes + phone`;
});

await step('providers page shows the ENS proof (block, resolver, payee)', async () => {
  await go('#/providers');
  await visible('12004338');
  const resolver = await page.locator('a[href^="https://sepolia.etherscan.io/address/0x"]').count();
  const payee = await page.locator('a[href^="https://hashscan.io/testnet/account/"]').count();
  if (resolver < 2 || payee < 2)
    throw new Error(`resolver links ${resolver}, payee links ${payee}`);
  await shot('providers');
});

await step('overview: the latest run with its stages and proofs', async () => {
  await go('#/');
  await page.locator('.latest .track-stage').first().waitFor();
  await visible('Mock run, not verification');
  const tx = await page
    .locator('.latest a[href^="https://hashscan.io/testnet/transaction/"]')
    .count();
  if (tx !== 2) throw new Error(`${tx} transactions in the latest run`);
  await shot('overview');
});

await step("runs: this deployment's runs only, no development files; raw events", async () => {
  await go('#/evidence');
  await page.getByRole('heading', { level: 1, name: 'Runs' }).waitFor();
  if ((await page.getByRole('heading', { name: 'Development evidence' }).count()) > 0)
    throw new Error('development evidence is still shown');
  await visible('This server runs the mock harness');
  const card = page.locator('.run-card').first();
  await card.getByText('Mock run, not verification').waitFor();
  if ((await page.locator('.run-cards').getByText('End-to-end verified').count()) > 0)
    throw new Error('a deployment run is shown as end-to-end verified');
  await card.getByRole('button', { name: /^Raw events/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Raw events' });
  await drawer.locator('pre').waitFor();
  const raw = (await drawer.locator('pre').textContent()) ?? '';
  if (!raw.includes('"RUN_STARTED"') || !raw.includes('"environment": "mock"'))
    throw new Error('raw events missing RUN_STARTED or its environment');
  await shot('evidence-raw');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  await shot('evidence');
});

await step('activity log: newest first, Show 10 more, Show less, details', async () => {
  await go('#/logs');
  await page.locator('ol.logs > li').first().waitFor();
  const count = () => page.locator('ol.logs > li').count();
  if ((await count()) !== 10) throw new Error(`${await count()} rows at first`);
  const first = (await page.locator('ol.logs > li').first().textContent()) ?? '';
  if (!first.includes('Task finished')) throw new Error(`newest entry is "${first}"`);
  await page.getByRole('button', { name: 'Show 10 more' }).click();
  await page.locator('ol.logs > li').nth(10).waitFor();
  const more = await count();
  if (more <= 10) throw new Error(`${more} rows after Show 10 more`);
  await page.getByRole('button', { name: 'Show less' }).click();
  if ((await count()) !== 10) throw new Error(`${await count()} rows after Show less`);
  await page.locator('ol.logs > li').first().getByRole('button').click();
  await page.locator('ol.logs > li').first().locator('pre').waitFor();
  await shot('logs');
  return `${more} rows when expanded`;
});

await step(
  'spending rules: edit a limit, see what it does, save, read back after reload',
  async () => {
    await go('#/rules');
    await visible('From the server configuration');
    await page.getByLabel('Per task', { exact: true }).fill('0.005');
    await visible('Cannot be more than the per-task limit.'); // per payment is still 0.01
    await page.getByLabel('Per payment', { exact: true }).fill('0.002');
    await visible('Per task: 0.03 HBAR to 0.005 HBAR');
    await visible(/^Tighter: a task may spend at most 0.005 HBAR/);
    await page.getByLabel('Per task', { exact: true }).fill('5');
    await visible('The server allows at most 0.03 HBAR per task.');
    if (!(await page.getByRole('button', { name: 'Save rules' }).isDisabled()))
      throw new Error('save enabled above the ceiling');
    await page.getByLabel('Per task', { exact: true }).fill('0.005');
    await page.getByLabel('Reason (kept in the history, optional)').fill('smoke test');
    await shot('rules-edit');
    await page.getByRole('button', { name: 'Save rules' }).click();
    await visible('Read back from the server: these rules are in force now.');
    await page.reload();
    await page.waitForLoadState('networkidle');
    await visible(/^Owner rules v1/);
    const inForce = await page
      .locator('table.limits tbody tr')
      .nth(1)
      .locator('td')
      .first()
      .textContent();
    if (!inForce?.includes('0.005')) throw new Error(`per task in force after reload: ${inForce}`);
    await visible('smoke test');
  },
);

await step(
  'kill switch: pause is confirmed, enforced on new tasks, shown everywhere, resumable',
  async () => {
    await page.getByRole('button', { name: 'Pause all payments' }).click();
    await page.getByRole('button', { name: 'Pause payments', exact: true }).click();
    await page.getByRole('heading', { name: 'Payments are paused' }).waitFor();
    await visible('Kill switch on: every payment is refused');
    await shot('rules-paused');
    await go('#/new');
    await visible('Payments are paused (kill switch), so no task can start.');
    await page.getByLabel('What should the agent watch?').fill('OpenSSL');
    if (!(await page.getByRole('button', { name: 'Start task' }).isDisabled()))
      throw new Error('start enabled while paused');
    // the server refuses too, whatever the page does
    const status = await page.evaluate(
      "fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchlist: 'OpenSSL' }) }).then((r) => r.status)",
    );
    if (Number(status) !== 409) throw new Error(`server answered ${String(status)} while paused`);
    await go('#/');
    await visible('Payments paused');
    await go('#/rules');
    await page.getByRole('button', { name: 'Resume payments' }).click();
    await page.getByRole('heading', { name: 'Payments are allowed' }).waitFor();
    await visible(/^Owner rules v3/);
  },
);

await step(
  "daily brief: create a schedule; the server runs today's brief once, with a delta",
  async () => {
    await go('#/schedule');
    await visible('No schedule yet.');
    await page.getByRole('button', { name: 'Add a schedule' }).click();
    await page.getByLabel('Watchlist').fill('OpenSSL\nlodash@4.17.21 (npm)');
    await page.getByLabel('Run after (UTC)').fill('25:00');
    await page.getByRole('button', { name: 'Create schedule' }).click();
    await visible('A UTC time as HH:MM, such as 00:15.');
    await page.getByLabel('Run after (UTC)').fill('00:00');
    await page.getByRole('button', { name: 'Create schedule' }).click();
    await page.locator('.schedule-card').first().waitFor();
    // the time has passed today (UTC), so the server starts the brief at once; wait for it to finish
    const row = page.locator('table.schedule-runs tbody tr').first();
    for (
      let i = 0;
      i < 20 && !((await row.textContent().catch(() => '')) ?? '').includes('Finished');
      i++
    ) {
      await page.waitForTimeout(1_000);
      await page.reload();
      await page.waitForLoadState('networkidle');
    }
    const text = (await row.textContent()) ?? '';
    if (!text.includes('Finished')) throw new Error(`scheduled run row: "${text}"`);
    if (!text.includes('Mock run, not verification')) throw new Error('mock verdict missing');
    // the manual task earlier had the same watchlist, so this brief compares against it
    if (!/0 new, 0 no longer in the data, 0 priority changes/.test(text))
      throw new Error(`delta: "${text}"`);
    if ((await page.locator('table.schedule-runs tbody tr').count()) !== 1)
      throw new Error('more than one brief today');
    await visible(/^Next brief: /);
    await shot('schedule');
  },
);

await step(
  'human approval (D-066): switch on, each payment waits, approve in the task page, switch off',
  async () => {
    await go('#/rules');
    await visible('In force: payments within the limits go ahead without asking.');
    await page.getByRole('radio', { name: /Human approval/ }).check();
    await visible('Approval: Autonomous to Human approval');
    await page.getByLabel('Ask when a payment is more than').fill('0');
    await page.getByRole('button', { name: 'Save rules' }).click();
    await visible('Read back from the server: these rules are in force now.');
    await visible('In force: every payment waits for your approval.');
    await visible('Human approval on');
    await shot('rules-human');

    await go('#/new');
    await page.getByLabel('What should the agent watch?').fill('OpenSSL\nlodash@4.17.21 (npm)');
    await page.getByLabel('Budget for this task').fill('0.003');
    await page.getByRole('button', { name: 'Start task' }).click();
    await page.waitForURL(/#\/tasks\/[0-9a-f-]{36}$/);
    let approved = 0;
    for (const provider of ['kev', 'osv']) {
      const prompt = page
        .locator('.approval-prompt')
        .filter({ hasText: `${provider}.chirag126.eth` });
      await prompt.waitFor({ timeout: 30_000 });
      await prompt.getByText(/^Expires in \d/).waitFor();
      if (approved === 0) {
        await visible('1 payment waiting for your approval');
        await visible('Waiting for your approval');
        await shot('task-approval');
      }
      await prompt.getByRole('button', { name: 'Approve payment' }).click();
      await prompt.waitFor({ state: 'detached', timeout: 10_000 });
      approved += 1;
    }
    await page.getByText('Task finished').first().waitFor({ timeout: 30_000 });
    const yes = await page.getByText('You approved the payment').count();
    if (yes !== 2) throw new Error(`${yes} approvals in the trail`);
    const signed = await page
      .locator('a[href^="https://hashscan.io/testnet/transaction/"]')
      .count();
    if (signed < 2) throw new Error(`${signed} transactions after approval`);

    await go('#/approvals');
    await visible('Nothing is waiting for your approval.');
    const rows = await page.locator('tbody tr').filter({ hasText: 'Approved' }).count();
    if (rows !== 2) throw new Error(`${rows} approved rows`);
    await shot('approvals');

    await go('#/rules');
    await page.getByRole('radio', { name: /Autonomous/ }).check();
    await page.getByRole('button', { name: 'Add a provider cap' }).click();
    await page.getByLabel('Provider ENS name, row 1').fill('kev.chirag126.eth');
    await page.getByLabel('Daily cap in HBAR, row 1').fill('99');
    await visible('Cannot be more than the daily limit.');
    await page.getByLabel('Daily cap in HBAR, row 1').fill('0.004');
    await visible('Daily cap for kev.chirag126.eth: No cap to 0.004 HBAR');
    await page.getByRole('button', { name: 'Save rules' }).click();
    await visible('Read back from the server: these rules are in force now.');
    await visible('In force: payments within the limits go ahead without asking.');
    await visible('1 provider cap(s).');
    return `${approved} payments approved in the browser`;
  },
);

await step('holder lane: status is honest; tasks on holder credits are not offered', async () => {
  await go('#/holder');
  await page.getByRole('heading', { level: 1, name: 'Holder lane' }).waitFor();
  await visible('Not available');
  await visible(/^Running tasks on a holder’s 0G credits/);
  // not in the navigation while blocked (D-089); the route still answers
  if ((await page.locator('nav[aria-label="Main"] a[href="#/holder"]').count()) > 0)
    throw new Error('the blocked holder lane is listed in the navigation');
  if ((await page.getByRole('button', { name: /holder credits/i }).count()) > 0)
    throw new Error('a control to run on holder credits is shown');
  await shot('holder');
});

// ── Phase UI toggle: Classic (default) / Electric, appearance only ─────────
const themeOf = async () =>
  String(await page.evaluate("document.documentElement.getAttribute('data-theme')"));
const savedTheme = async () =>
  String(await page.evaluate("localStorage.getItem('threat-intel-agent:theme')"));
/** The switch lives on Overview; a theme lasts until the page is loaded again (D-075). */
const pickTheme = async (name: 'Classic' | 'Electric' | 'EnderPay') => {
  await go('#/');
  await page
    .getByRole('group', { name: 'Interface theme' })
    .getByRole('button', { name, exact: true })
    .click();
};
const bodyBackground = async () =>
  String(await page.evaluate('getComputedStyle(document.body).backgroundColor'));
const ALL_ROUTES = [
  '#/',
  '#/new',
  '#/schedule',
  '#/evidence',
  '#/logs',
  '#/payments',
  '#/approvals',
  '#/usage',
  '#/providers',
  '#/rules',
  '#/holder',
];

await step(
  'theme: Classic by default; Electric from the Overview switch, kept across tabs; every load opens Classic',
  async () => {
    await go('#/');
    if ((await themeOf()) !== 'classic') throw new Error(`default theme ${await themeOf()}`);
    const classicBg = await bodyBackground();
    const group = page.getByRole('group', { name: 'Interface theme' });
    if (
      (await group.getByRole('button', { name: 'Classic' }).getAttribute('aria-pressed')) !== 'true'
    )
      throw new Error('Classic is not shown as selected');
    // no reload and no request to the server when switching
    await page.evaluate('window.__noReload = 1');
    const requests: string[] = [];
    const onRequest = (r: { url(): string }) => requests.push(r.url());
    page.on('request', onRequest);
    await group.getByRole('button', { name: 'Electric' }).click();
    await page.waitForTimeout(400);
    page.off('request', onRequest);
    if ((await themeOf()) !== 'electric') throw new Error('Electric not applied');
    if (Number(await page.evaluate('window.__noReload')) !== 1)
      throw new Error('the page reloaded');
    const themeCalls = requests.filter(
      (u) => !/\/api\/(health|runs|payments|inference|evidence|config|session)/.test(u),
    );
    if (themeCalls.length > 0) throw new Error(`unexpected requests: ${themeCalls.join(', ')}`);
    if ((await savedTheme()) !== 'null') throw new Error('the theme was saved (D-075)');
    if ((await bodyBackground()) === classicBg) throw new Error('the page did not change colour');
    await visible('Agent command center');
    await shot('electric-overview');
    // the session and data survive: still unlocked, still the same runs
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Payments' })
      .click();
    await page.getByRole('heading', { level: 1, name: 'Payments' }).waitFor();
    if ((await themeOf()) !== 'electric') throw new Error('lost on navigation');
    // a new page load opens in Classic, and a choice saved by an older version is removed (D-075)
    await page.evaluate("localStorage.setItem('threat-intel-agent:theme', 'enderpay')");
    await page.reload();
    await page.waitForLoadState('networkidle');
    if ((await themeOf()) !== 'classic') throw new Error(`reload opened ${await themeOf()}`);
    if ((await savedTheme()) !== 'null') throw new Error('the old saved theme was not removed');
    await pickTheme('Electric');
    if ((await themeOf()) !== 'electric') throw new Error('Electric not applied again');
    await go('#/new');
    if (
      await page
        .getByLabel('Access code')
        .isVisible()
        .catch(() => false)
    )
      throw new Error('the session was lost');
  },
);

await step('electric: every tab renders, nothing scrolls sideways, screenshots', async () => {
  for (const hash of ALL_ROUTES) {
    await go(hash);
    await page.locator('h1').first().waitFor();
    await shot(`electric-${hash === '#/' ? 'overview-full' : hash.slice(2)}`);
  }
  await page.goto(taskUrl);
  await visible('Task finished');
  await shot('electric-task');
  // the cobalt is really on the data containers, not only the background
  await go('#/payments');
  await page.locator('table.payments thead th').first().waitFor();
  const header = String(
    await page.evaluate(
      "getComputedStyle(document.querySelector('table.payments thead th')).backgroundColor",
    ),
  );
  const frame = String(
    await page.evaluate("getComputedStyle(document.querySelector('.table-wrap')).borderTopColor"),
  );
  if (!header.includes('36, 91, 255') || !frame.includes('71, 123, 255'))
    throw new Error(`table header ${header}, frame ${frame}: cobalt missing`);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const hash of ALL_ROUTES) {
    await go(hash);
    const overflow = Number(
      await page.evaluate(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      ),
    );
    if (overflow > 1) throw new Error(`${hash} scrolls sideways by ${overflow}px in Electric`);
  }
  await go('#/');
  await shot('electric-overview-phone');
  await page.setViewportSize({ width: 1280, height: 860 });
  return `${ALL_ROUTES.length + 1} pages`;
});

await step(
  'enderpay: chosen on Overview, every tab renders in the block theme; a reload opens Classic',
  async () => {
    await go('#/');
    const group = page.getByRole('group', { name: 'Interface theme' });
    for (const name of ['Classic', 'Electric', 'EnderPay'])
      await group.getByRole('button', { name, exact: true }).waitFor();
    await group.getByRole('button', { name: 'EnderPay', exact: true }).click();
    if ((await themeOf()) !== 'enderpay') throw new Error('EnderPay not applied');
    if ((await savedTheme()) !== 'null') throw new Error('EnderPay was saved (D-075)');
    // the pixel font is served by the app itself (CSP font-src 'self') and used for headings
    const fontOk = String(
      await page.evaluate(
        'document.fonts.load(\'16px "EnderPay Pixel"\').then((f) => f.length > 0)',
      ),
    );
    if (fontOk !== 'true') throw new Error('the pixel font did not load');
    const heading = String(
      await page.evaluate("getComputedStyle(document.querySelector('h1')).fontFamily"),
    );
    if (!heading.includes('EnderPay Pixel')) throw new Error(`h1 font: ${heading}`);
    await page.reload();
    await page.waitForLoadState('networkidle');
    if ((await themeOf()) !== 'classic') throw new Error(`reload opened ${await themeOf()}`);
    await pickTheme('EnderPay');
    if ((await themeOf()) !== 'enderpay') throw new Error('EnderPay not applied again');
    for (const hash of ALL_ROUTES) {
      await go(hash);
      await page.locator('h1').first().waitFor();
      await shot(`enderpay-${hash === '#/' ? 'overview' : hash.slice(2)}`);
    }
    await page.goto(taskUrl);
    await visible('Task finished');
    await shot('enderpay-task');
    await page.setViewportSize({ width: 390, height: 844 });
    for (const hash of ALL_ROUTES) {
      await go(hash);
      const overflow = Number(
        await page.evaluate(
          'document.documentElement.scrollWidth - document.documentElement.clientWidth',
        ),
      );
      if (overflow > 1) throw new Error(`${hash} scrolls sideways by ${overflow}px in EnderPay`);
    }
    await go('#/');
    await shot('enderpay-overview-phone');
    await page.setViewportSize({ width: 1280, height: 860 });
    return `${ALL_ROUTES.length + 1} pages`;
  },
);

// ── EnderPay audio (D-072, D-073, D-074), played for real in Chromium ───
// The repo ships the click sound and the owner's twelve tracks (64 kbps mono),
// and the API serves them itself, as on Render. One track (Dry Hands) is
// turned into a 404 here, because a not-installed track must still look
// honest; everything else is the real file from the real server.
const MISSING = '/audio/music/dry-hands.mp3';
await page.route('**/audio/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === MISSING)
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not installed' });
  else await route.continue();
});
await context.addInitScript(
  [
    'window.__media = []; window.__plays = []; window.__clicks = []; window.__srcs = [];',
    // media plays (music) and the source each was given
    'const p = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { if (!window.__media.includes(this)) window.__media.push(this); window.__plays.push(this.src); return p.call(this); };',
    "const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src'); Object.defineProperty(HTMLMediaElement.prototype, 'src', { get() { return d.get.call(this); }, set(v) { window.__srcs.push(String(v)); d.set.call(this, v); }, configurable: true });",
    // click sounds: Web Audio buffer sources (offset into the decoded file)
    'const st = AudioBufferSourceNode.prototype.start; AudioBufferSourceNode.prototype.start = function (when, offset) { window.__clicks.push({ offset: offset || 0, duration: this.buffer ? this.buffer.duration : 0 }); return st.apply(this, arguments); };',
  ].join(' '),
);
// the music element: every media element that is not the click fallback (there is exactly one)
const MUSIC_EL = "window.__media.filter((m) => !m.src.endsWith('/audio/enderpay-click.mp3'))";
const musicInfo = async () =>
  JSON.parse(
    String(
      await page.evaluate(
        `JSON.stringify((() => { const ms = ${MUSIC_EL}; const m = ms[ms.length - 1]; return { count: ms.length, src: m ? m.getAttribute('src') : null, paused: m ? m.paused : true, time: m ? m.currentTime : 0, volume: m ? m.volume : 0, duration: m ? m.duration : 0 }; })())`,
      ),
    ),
  ) as {
    count: number;
    src: string | null;
    paused: boolean;
    time: number;
    volume: number;
    duration: number;
  };
// click sounds are decoded once and played through Web Audio from the click's onset
const clickPlays = async () =>
  Number(
    await page.evaluate(
      "window.__clicks.length + window.__plays.filter((s) => s.endsWith('/audio/enderpay-click.mp3')).length",
    ),
  );
const musicButton = () => page.getByRole('button', { name: /^Background music/ });
const sfxButton = () => page.getByRole('button', { name: /^Click sounds/ });
const waitClass = async (cls: string, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if (((await musicButton().getAttribute('class')) ?? '').includes(cls)) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`music button never became ${cls}: ${await musicButton().getAttribute('class')}`);
};
const navTo = (route: string) =>
  page.locator(`nav[aria-label="Main"] a[href="#/${route}"]`).click();
/** Wait until the music element plays `file`, then return its state. */
const playingFile = async (file: string) => {
  for (let i = 0; i < 40; i++) {
    const m = await musicInfo();
    if (m.src === `/audio/music/${file}` && !m.paused && m.time > 0) return m;
    await page.waitForTimeout(150);
  }
  throw new Error(`${file} never played: ${JSON.stringify(await musicInfo())}`);
};
// tab, its file, and the owner's start position (D-074)
const TRACKS: readonly (readonly [string, string, number])[] = [
  ['', 'minecraft.mp3', 12],
  ['new', 'aria-math.mp3', 150],
  ['schedule', 'mice-on-venus.mp3', 30],
  ['evidence', 'moog-city-2.mp3', 0],
  ['logs', 'subwoofer-lullaby.mp3', 0],
  ['payments', 'haggstrom.mp3', 0],
  ['approvals', 'sweden.mp3', 0],
  ['usage', 'excuse.mp3', 0],
  ['rules', 'key.mp3', 6],
];

await step(
  'enderpay audio: real tracks from the API, start positions, one element, missing is honest',
  async () => {
    await page.reload();
    await page.waitForLoadState('networkidle');
    if ((await themeOf()) !== 'classic') throw new Error('a reload did not open Classic');
    // EnderPay is chosen again after every load (D-075); nothing plays before that
    if (!(await musicInfo()).paused) throw new Error('music played in Classic');
    // the API itself serves the click file, as on Render (D-073)
    const served = String(
      await page.evaluate(
        "fetch('/audio/enderpay-click.mp3').then((r) => r.status + ' ' + r.headers.get('content-type'))",
      ),
    );
    if (served !== '200 audio/mpeg') throw new Error(`click file served as ${served}`);
    // every one of the twelve files is served by the API and decodes in Chromium (D-074)
    const files = [...TRACKS.map(([, f]) => f), 'dry-hands.mp3', 'wet-hands.mp3'];
    const decoded: string[] = [];
    for (const f of files) {
      const res = await fetch(`${base}/audio/music/${f}`);
      if (res.status !== 200 || res.headers.get('content-type') !== 'audio/mpeg')
        throw new Error(`${f} served as ${res.status} ${res.headers.get('content-type')}`);
      await res.arrayBuffer();
      if (f === 'dry-hands.mp3') continue; // the browser sees this one as a 404 on purpose
      const sec = Number(
        await page.evaluate(
          `fetch('/audio/music/${f}').then((r) => r.arrayBuffer()).then((b) => new OfflineAudioContext(1, 1, 44100).decodeAudioData(b)).then((a) => a.duration)`,
        ),
      );
      const start = TRACKS.find(([, x]) => x === f)?.[2] ?? 0;
      if (!(sec > start + 30)) throw new Error(`${f} decoded to ${sec} s`);
      decoded.push(`${f.replace('.mp3', '')} ${Math.round(sec)}s`);
    }
    // only now EnderPay, so the start positions below are checked while fresh
    await pickTheme('EnderPay');
    if ((await themeOf()) !== 'enderpay') throw new Error('not in EnderPay');
    if (((await sfxButton().getAttribute('class')) ?? '').includes('audio-missing'))
      throw new Error('click sound reported missing');
    if ((await musicButton().getAttribute('aria-pressed')) !== 'true')
      throw new Error('music is not on by default');
    // autoplay may be refused without a gesture: then the button says so, and one click starts it
    let blocked = false;
    for (let i = 0; i < 20; i++) {
      const cls = (await musicButton().getAttribute('class')) ?? '';
      if (cls.includes('audio-playing')) break;
      if (cls.includes('audio-blocked')) {
        blocked = true;
        await page.getByText('Click to start').waitFor();
        await page.locator('h1').first().click();
        break;
      }
      await page.waitForTimeout(250);
    }
    await waitClass('audio-playing');
    // every tab: its own track, from the owner's start position, on the one element
    for (const [tab, file, start] of TRACKS) {
      await navTo(tab);
      const m = await playingFile(file);
      if (m.time < start || m.time > start + 3 || m.count !== 1)
        throw new Error(`${tab}: ${JSON.stringify(m)} (start ${start})`);
    }
    // a revisited tab starts again from its start, not where it was left
    await navTo('logs');
    await playingFile('subwoofer-lullaby.mp3');
    await page.waitForTimeout(2500);
    const left = await musicInfo();
    await navTo('payments');
    await playingFile('haggstrom.mp3');
    await navTo('logs');
    const back = await playingFile('subwoofer-lullaby.mp3');
    if (!(left.time > 2) || back.time > 1.5 || back.count !== 1)
      throw new Error(`Logs revisit: left at ${left.time}, back at ${back.time}`);
    // a track that is not installed: shown as such, nothing claims to play
    await navTo('providers');
    await waitClass('audio-missing');
    await page.getByText('Not installed').waitFor();
    await page.waitForTimeout(800);
    if (!(await musicInfo()).paused) throw new Error('music still playing on a missing track');
    // two non-tab pages share Wet Hands: no restart between them
    await page.goto(taskUrl);
    await waitClass('audio-playing');
    await playingFile('wet-hands.mp3');
    await page.waitForTimeout(800);
    const before = await musicInfo();
    const playsBefore = Number(await page.evaluate('window.__plays.length'));
    const srcsBefore = Number(await page.evaluate('window.__srcs.length'));
    await page.goto(`${base}/#/no-such-page`);
    await page.waitForTimeout(800);
    const after = await musicInfo();
    const playsAfter = Number(await page.evaluate('window.__plays.length'));
    const srcsAfter = Number(await page.evaluate('window.__srcs.length'));
    if (
      after.src !== '/audio/music/wet-hands.mp3' ||
      after.paused ||
      after.time <= before.time ||
      srcsAfter !== srcsBefore ||
      playsAfter !== playsBefore
    )
      throw new Error(
        `same track restarted: ${JSON.stringify({ before, after, playsBefore, playsAfter, srcsBefore, srcsAfter })}`,
      );
    await shot('enderpay-audio-bar');
    return `${blocked ? 'autoplay blocked, one click started it' : 'autoplay allowed'}; decoded ${decoded.join(', ')}`;
  },
);

// Records what the music element does, sampled every 100 ms: volume, position, paused.
const RECORD = `(() => { const ms = ${MUSIC_EL}; const m = ms[ms.length - 1]; window.__rec = []; window.__ev = []; const t0 = performance.now(); for (const type of ['ended', 'playing', 'seeked']) m.addEventListener(type, () => window.__ev.push({ type, at: performance.now() - t0, time: m.currentTime })); clearInterval(window.__recId); window.__recId = setInterval(() => window.__rec.push({ at: performance.now() - t0, v: m.volume, time: m.currentTime, paused: m.paused, d: m.duration }), 100); return true; })()`;
const recorded = async () =>
  JSON.parse(
    String(await page.evaluate('JSON.stringify({ rec: window.__rec, ev: window.__ev })')),
  ) as {
    rec: { at: number; v: number; time: number; paused: boolean; d: number }[];
    ev: { type: string; at: number; time: number }[];
  };
const seekNearEnd = (left: number) =>
  page.evaluate(
    `(() => { const ms = ${MUSIC_EL}; const m = ms[ms.length - 1]; m.currentTime = m.duration - ${left}; return m.currentTime; })()`,
  );
const setVolume = async (pct: number) => {
  // the native setter plus an input event, which is what React's onChange listens to
  await page.evaluate(
    `(() => { const el = document.querySelector('.audio-volume input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '${pct}'); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`,
  );
  await page.waitForTimeout(150);
};

await step(
  'enderpay audio: fades out over the last 4.5 s, 2 s of silence, again from its start at the chosen volume',
  async () => {
    await go('#/rules'); // Key: starts at 0:06
    await waitClass('audio-playing');
    await playingFile('key.mp3');
    await setVolume(80);
    await page.waitForTimeout(600); // let the fade-in finish
    let m = await musicInfo();
    if (Math.abs(m.volume - 0.8) > 0.01) throw new Error(`volume ${m.volume}, slider 80`);
    await page.evaluate(RECORD);
    await seekNearEnd(7);
    // the end, then the 2 s gap, then the start again (fade-in 0.4 s)
    let ev: { type: string; at: number; time: number }[] = [];
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(250);
      ev = (await recorded()).ev;
      const end = ev.findIndex((e) => e.type === 'ended');
      if (end >= 0 && ev.slice(end).some((e) => e.type === 'playing')) break;
    }
    await page.waitForTimeout(800);
    const { rec } = await recorded();
    ev = (await recorded()).ev;
    const endAt = ev.find((e) => e.type === 'ended')?.at;
    const again = ev.find((e) => e.type === 'playing' && endAt !== undefined && e.at > endAt);
    if (endAt === undefined || again === undefined)
      throw new Error(`no end and repeat: ${JSON.stringify(ev)}`);
    const gap = again.at - endAt;
    if (gap < 1900 || gap > 2800) throw new Error(`gap ${Math.round(gap)} ms`);
    // the fade: full level until ~4.5 s before the end, then down smoothly to (almost) silence
    const d = rec.find((r) => r.d > 0)?.d ?? 0;
    const tail = rec.filter((r) => !r.paused && r.at < endAt && r.time > 1);
    const early = tail.filter((r) => d - r.time > 5);
    const fading = tail.filter((r) => d - r.time <= 4.4 && d - r.time >= 0.2);
    if (early.length === 0 || early.some((r) => Math.abs(r.v - 0.8) > 0.02))
      throw new Error(`not at 0.8 before the fade: ${JSON.stringify(early.map((r) => r.v))}`);
    if (fading.length < 25) throw new Error(`only ${fading.length} samples in the fade`);
    for (let i = 1; i < fading.length; i++) {
      const a = fading[i - 1];
      const b = fading[i];
      if (a === undefined || b === undefined) continue;
      if (b.v > a.v + 0.005) throw new Error(`fade went up: ${a.v} -> ${b.v}`);
      if (a.v - b.v > 0.1) throw new Error(`fade jumped: ${a.v} -> ${b.v}`);
      const expect = 0.8 * Math.min(1, (d - b.time) / 4.5);
      if (Math.abs(b.v - expect) > 0.06) throw new Error(`fade ${b.v} at ${d - b.time}s left`);
    }
    const lastBeforeEnd = tail[tail.length - 1];
    if (lastBeforeEnd === undefined || lastBeforeEnd.v > 0.05)
      throw new Error(`not silent at the end: ${JSON.stringify(lastBeforeEnd)}`);
    // silence during the gap: paused, nothing else playing
    const during = rec.filter((r) => r.at > endAt + 200 && r.at < again.at - 100);
    if (during.length < 10 || during.some((r) => !r.paused))
      throw new Error('something played during the gap');
    // again from Key's start (0:06), back at the chosen 80 %, and the slider untouched
    m = await musicInfo();
    if (m.paused || m.src !== '/audio/music/key.mp3' || m.time < 6 || m.time > 8 || m.count !== 1)
      throw new Error(`repeat: ${JSON.stringify(m)}`);
    if (Math.abs(m.volume - 0.8) > 0.01) throw new Error(`repeat volume ${m.volume}`);
    if ((await page.locator('.audio-volume input').inputValue()) !== '80')
      throw new Error('the fade moved the slider');
    // the slider moved during the fade: the fade follows it, the repeat comes back at the new level
    await page.evaluate(RECORD);
    await seekNearEnd(4);
    await page.waitForTimeout(1500);
    await setVolume(40);
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250);
      const r = await recorded();
      const end = r.ev.findIndex((e) => e.type === 'ended');
      if (end >= 0 && r.ev.slice(end).some((e) => e.type === 'playing')) break;
    }
    await page.waitForTimeout(800);
    const second = await recorded();
    const end2 = second.ev.find((e) => e.type === 'ended')?.at ?? Infinity;
    const after40 = second.rec.filter((r) => !r.paused && r.at < end2 && r.v > 0 && r.at > 1800);
    if (after40.some((r) => r.v > 0.4 * ((r.d - r.time) / 4.5) + 0.03))
      throw new Error('the fade ignored the new volume');
    m = await musicInfo();
    if (Math.abs(m.volume - 0.4) > 0.01 || m.time < 6 || m.time > 8)
      throw new Error(`after volume change: ${JSON.stringify(m)}`);
    await page.evaluate('clearInterval(window.__recId)');
    return `gap ${Math.round(gap)} ms; fade ${fading.length} samples from 0.8 to ${lastBeforeEnd.v.toFixed(3)}; repeat at ${m.time.toFixed(1)} s, 40 % kept`;
  },
);

await step(
  'enderpay audio: music off or another tab during the gap cancels the repeat; on again starts from the start',
  async () => {
    await go('#/rules');
    await waitClass('audio-playing');
    await playingFile('key.mp3');
    await page.waitForTimeout(500);
    await seekNearEnd(1.5);
    await waitClass('audio-repeat', 20);
    // music off in the gap: nothing comes back
    const plays = Number(await page.evaluate('window.__plays.length'));
    await musicButton().click();
    await page.waitForTimeout(3000);
    if (Number(await page.evaluate('window.__plays.length')) !== plays)
      throw new Error('the repeat fired after music was switched off');
    if (!(await musicInfo()).paused) throw new Error('playing after off');
    // on again: Key from its start
    await musicButton().click();
    const m = await playingFile('key.mp3');
    if (m.time < 6 || m.time > 8 || m.count !== 1)
      throw new Error(`on again: ${JSON.stringify(m)}`);
    // another tab in the gap: the old repeat never fires on top of the new track
    await page.waitForTimeout(500);
    await seekNearEnd(1.5);
    await waitClass('audio-repeat', 20);
    await navTo('evidence');
    await playingFile('moog-city-2.mp3');
    const srcs = Number(await page.evaluate('window.__srcs.length'));
    await page.waitForTimeout(3000);
    const e = await musicInfo();
    if (
      e.src !== '/audio/music/moog-city-2.mp3' ||
      e.paused ||
      e.count !== 1 ||
      Number(await page.evaluate('window.__srcs.length')) !== srcs ||
      e.time < 3
    )
      throw new Error(`after leaving in the gap: ${JSON.stringify(e)}`);
    return 'off in the gap: silent; on: Key from 0:06; leaving in the gap: no stray repeat';
  },
);

await step(
  'enderpay audio: music and click sounds are independent, persisted, and silent outside EnderPay',
  async () => {
    await go('#/');
    await waitClass('audio-playing');
    // music off: stops, stays off across tabs and a reload
    await musicButton().click();
    await page.waitForTimeout(700);
    if ((await musicButton().getAttribute('aria-pressed')) !== 'false') throw new Error('not off');
    if (!(await musicInfo()).paused) throw new Error('music still playing after off');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Payments' })
      .click();
    await page.waitForTimeout(500);
    if (!(await musicInfo()).paused) throw new Error('music started on another tab while off');
    await page.reload();
    await page.waitForLoadState('networkidle');
    // the theme is not remembered (D-075), the sound settings are
    if ((await themeOf()) !== 'classic') throw new Error('a reload did not open Classic');
    await pickTheme('EnderPay');
    if ((await musicButton().getAttribute('aria-pressed')) !== 'false')
      throw new Error('off not kept');
    // click sounds still work with music off: one per real click, none for text
    const c0 = await clickPlays();
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Overview' })
      .click();
    await page.waitForTimeout(300);
    const c1 = await clickPlays();
    if (c1 !== c0 + 1) throw new Error(`nav click played ${c1 - c0} sounds`);
    await page.locator('h1').first().click();
    await page.waitForTimeout(300);
    if ((await clickPlays()) !== c1) throw new Error('a click on a heading made a sound');
    // the real file was decoded (0.89 s) and played from its click, after ~0.54 s of silence
    const last = JSON.parse(
      String(
        await page.evaluate('JSON.stringify(window.__clicks[window.__clicks.length - 1] || null)'),
      ),
    ) as { offset: number; duration: number } | null;
    if (
      last === null ||
      last.duration < 0.8 ||
      last.duration > 1 ||
      last.offset < 0.5 ||
      last.offset > 0.65
    )
      throw new Error(`click played from the wrong point: ${JSON.stringify(last)}`);
    // ... and nothing plays while the page just refreshes itself
    await page.waitForTimeout(5_500);
    if ((await clickPlays()) !== c1) throw new Error('a background refresh made a sound');
    // click sounds off, music on: music plays, clicks are silent
    await sfxButton().click();
    if ((await sfxButton().getAttribute('aria-pressed')) !== 'false')
      throw new Error('sfx not off');
    const c2 = await clickPlays();
    await musicButton().click();
    await waitClass('audio-playing');
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Approvals' })
      .click();
    await page.waitForTimeout(1200);
    if ((await clickPlays()) !== c2) throw new Error('click sound played while off');
    const m = await musicInfo();
    if (m.paused || m.src !== '/audio/music/sweden.mp3')
      throw new Error(`music: ${JSON.stringify(m)}`);
    await sfxButton().click();
    // another theme: music stops, controls disappear, clicks are silent
    await go('#/');
    await page
      .getByRole('group', { name: 'Interface theme' })
      .getByRole('button', { name: 'Electric' })
      .click();
    await page.waitForTimeout(800);
    if (!(await musicInfo()).paused) throw new Error('music kept playing in Electric');
    if ((await musicButton().count()) !== 0) throw new Error('audio controls shown in Electric');
    const c3 = await clickPlays();
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Payments' })
      .click();
    await page.waitForTimeout(300);
    if ((await clickPlays()) !== c3) throw new Error('click sound in Electric');
    // back to EnderPay: the saved preference (music on) applies again
    await go('#/');
    await page
      .getByRole('group', { name: 'Interface theme' })
      .getByRole('button', { name: 'EnderPay', exact: true })
      .click();
    await waitClass('audio-playing');
    return 'music off + clicks on, music on + clicks off, Electric silent';
  },
);

await step('theme: reduced motion switches without the transition; back to Classic', async () => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await go('#/');
  const group = page.getByRole('group', { name: 'Interface theme' });
  await group.getByRole('button', { name: 'Classic' }).click();
  const animating = String(
    await page.evaluate("document.documentElement.classList.contains('theme-switching')"),
  );
  if (animating !== 'false') throw new Error('transition ran despite reduced motion');
  if ((await themeOf()) !== 'classic' || (await savedTheme()) !== 'null')
    throw new Error('Classic not restored');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

await step('phone width: no sideways scrolling, navigation works', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const hash of [
    '#/',
    '#/new',
    '#/evidence',
    '#/schedule',
    '#/logs',
    '#/providers',
    '#/payments',
    '#/usage',
    '#/rules',
    '#/approvals',
    '#/holder',
  ]) {
    await go(hash);
    // evaluated in the page (a string, so this Node script needs no DOM types)
    const overflow = Number(
      await page.evaluate(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      ),
    );
    if (overflow > 1) throw new Error(`${hash} scrolls sideways by ${overflow}px`);
  }
  await go('#/');
  await shot('overview-phone');
  await page.goto(taskUrl);
  await visible('Task finished');
  await shot('task-phone');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Payments' })
    .click();
  await page.getByRole('heading', { level: 1, name: 'Payments' }).waitFor();
  await page.setViewportSize({ width: 1280, height: 860 });
});

await step('dark colour scheme renders', async () => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await go('#/');
  await shot('overview-dark');
  await go('#/rules');
  await shot('rules-dark');
  await page.emulateMedia({ colorScheme: 'light' });
});

await step('served by the API on one origin, under the app CSP (D-062)', async () => {
  const res = await page.request.get(`${base}/`);
  const csp = res.headers()['content-security-policy'] ?? '';
  if (!csp.includes("script-src 'self'") || !csp.includes("frame-ancestors 'none'"))
    throw new Error(`page CSP: ${csp || 'missing'}`);
  return 'no CSP violation is logged (checked in the next step)';
});

await step('no errors in the browser console', async () => {
  const relevant = consoleErrors.filter((e) => !/Failed to load resource/.test(e));
  if (relevant.length > 0) throw new Error(relevant.slice(0, 3).join(' | '));
});

await step('when the API is down, the app says so', async () => {
  await api.close();
  await go('#/');
  await visible("Can't reach the agent API");
});

await browser.close();

const passed = results.filter((r) => r.ok).length;
console.log(`\nscreenshots: ${SHOTS}`);
console.log(
  passed === results.length
    ? `\nWEB SMOKE PASSED (MOCK API): ${passed}/${results.length} steps.`
    : `\nWEB SMOKE FAILED: ${results.length - passed} of ${results.length} steps failed (see above and fail-*.png).`,
);
if (passed !== results.length) process.exitCode = 1;
