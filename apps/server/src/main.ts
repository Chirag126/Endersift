/**
 * The agent's API server (plan row 26, D-048).
 *
 *   pnpm providers:start                                             (terminal 1, local providers)
 *   pnpm api:start -- --allow-local-http --from-block 11999808         (terminal 2)
 *
 * `--allow-local-http` is needed while the ENS records point to the local
 * provider service (http://127.0.0.1:4021); without it every provider is
 * skipped and tasks fail with NO_PROVIDERS. The scan start can also come from
 * ENS_DISCOVERY_FROM_BLOCK.
 *
 * The scheduler runs inside this process: each enabled schedule (Daily brief
 * page) starts one run per UTC day after its time; starting the server after
 * that time runs today's brief, never a missed day.
 *
 * Starts only with DEMO_ACCESS_CODE set (starting a task spends HBAR and 0G),
 * with every live env group valid, the 0G model priced and ETH_RPC_URL on
 * Sepolia (createLiveAgent). Runs left open by a previous process are closed
 * first. Listens on 127.0.0.1 in development and 0.0.0.0 in production
 * (Render). `--allow-local-http` (the local provider service) is refused in
 * production. SIGINT/SIGTERM: stop accepting, end the event streams, let the
 * running task finish (it may be mid-payment), then exit.
 */
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { loadEnv } from '@agent-economy/core';
import {
  UsageError,
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
} from '../../../scripts/lib/cli.ts';
import { createApi } from './api/server.ts';
import { readDeploymentRecords } from './deployment-records.ts';
import { TaskRunner } from './api/task-runner.ts';
import { loadServerConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { errorMessage, logError, logInfo } from './log.ts';
import { ScheduleStore } from './schedule/schedule-store.ts';
import { CATCH_UP_WINDOW_MIN, Scheduler } from './schedule/scheduler.ts';
import { seedDailyBrief } from './schedule/seed.ts';
import { LIVE_ENV_GROUPS, createLiveAgent, publicConfigOf } from './wiring.ts';

handleScriptErrors();

const source = loadLocalEnvSource();
const config = loadServerConfig(source);
if (config.demoAccessCode === null)
  throw new UsageError(
    'set DEMO_ACCESS_CODE (at least 12 characters) in .env: starting a task spends HBAR and 0G',
  );
const allowLocalHttp = hasFlag('--allow-local-http');
if (allowLocalHttp && config.nodeEnv === 'production')
  throw new UsageError('--allow-local-http is for local development only');
const fromBlockArg = argValue('--from-block');
if (fromBlockArg !== undefined && !/^\d{1,12}$/.test(fromBlockArg))
  throw new UsageError('--from-block must be a block number');

const env = loadEnv([...LIVE_ENV_GROUPS], source);
const scanFrom = fromBlockArg ?? env.get('ENS_DISCOVERY_FROM_BLOCK');
const { db, migration } = openDatabase(config.databasePath);
const agent = await createLiveAgent(env, db, {
  allowLocalHttp,
  logCachePath:
    config.databasePath === ':memory:'
      ? null
      : join(dirname(config.databasePath), 'ens-log-cache.json'),
  fromBlock: fromBlockArg === undefined ? null : BigInt(fromBlockArg),
  providerWakeMs: config.providerWakeSec * 1000,
});
const runner = new TaskRunner(agent.orchestrator, {
  maxPending: 3,
  onError: (id, error) => logError(`task ${id} could not be recorded: ${errorMessage(error)}`),
});
for (const r of runner.recover()) logInfo(`closed an interrupted task ${r.id} (${r.status})`);
// approval requests a previous process left open (D-066): expired, their payments never signed
const closedApprovals = await agent.closeOpenApprovals();
if (closedApprovals > 0)
  logInfo(`expired ${closedApprovals} approval request(s) left open by a previous process`);
// today's x402 spend from outside this database (D-062): read now for the UI; every run reads it
// again before spending, and fails closed if it cannot
void agent.chainFloor
  .refresh()
  .then((r) =>
    logInfo(
      `  spend check: ${r.count} x402 payment(s), ${r.tinybars} tinybars today not in this database (Mirror Node)`,
    ),
  )
  .catch((e: unknown) =>
    logError(
      `spend check: the Mirror Node could not be read (${errorMessage(e)}); runs will retry`,
    ),
  );
// HCS audit (D-057): settle messages a previous process left open, in the background
if (agent.auditor !== null)
  void agent.auditor
    .reconcile()
    .catch((e: unknown) => logError(`HCS audit reconcile: ${errorMessage(e)}`));

// daily watchlist briefs (D-056): one run per schedule per UTC day, after its time
const schedules = new ScheduleStore(db);
// a database wiped on restart forgets today's claim: catch up only shortly after the time (D-062)
const catchUpWindowMin = config.databaseEphemeral ? CATCH_UP_WINDOW_MIN : null;
if (config.dailyBrief !== null) {
  const seeded = seedDailyBrief(schedules, config.dailyBrief, agent.policy.maxPerRun);
  logInfo(
    `daily brief from DAILY_BRIEF_*: ${seeded.created ? 'created' : 'already present'} (schedule ${seeded.schedule.id})`,
  );
}
const scheduler = new Scheduler({
  db,
  store: schedules,
  submit: (request, budget, beforeStart) =>
    runner.submit(request, budget, { origin: 'scheduler', beforeStart }),
  log: logInfo,
  catchUpWindowMin,
});

// committed records: read once, so a malformed file is noticed at startup, not per request
const deploymentRecords = readDeploymentRecords(resolve('.'));
logInfo(
  `deployment records: ERC-8004 ${deploymentRecords.erc8004 === null ? 'none' : Object.keys(deploymentRecords.erc8004.agents).length + ' agent(s)'}, ENS setups ${deploymentRecords.setups === null ? 'none' : deploymentRecords.setups.setups.length}`,
);

const api = createApi({
  db,
  logError,
  runner,
  // "spent today" includes the Mirror Node reading of payments this database does not know (D-062)
  payments: {
    listByRun: (runId) => agent.store.listByRun(runId),
    listRecent: (limit) => agent.store.listRecent(limit),
    committed: async (input) => {
      const c = await agent.store.committed(input);
      return { ...c, day: c.day + agent.chainFloor.floorFor(input.dayStart) };
    },
  },
  outsideSpend: () => agent.chainFloor.last,
  approvals: agent.approvals,
  earnings: agent.earnings,
  deployment: () => deploymentRecords as unknown as Readonly<Record<string, unknown>>,
  inference: agent.ledger,
  accessCode: config.demoAccessCode,
  hashscan: agent.hashscan,
  migration: migration.current,
  evidenceRoot: resolve('docs/evidence'),
  corsOrigin: config.corsOrigin,
  trustProxyHops: config.trustProxyHops,
  secureCookies: config.nodeEnv === 'production',
  publicConfig: {
    ...publicConfigOf(agent, env.require('ENS_PARENT_NAME')),
    deployment: {
      ephemeralDatabase: config.databaseEphemeral,
      seededBrief: config.dailyBrief !== null,
      catchUpWindowMin,
    },
    providerWake:
      config.providerWakeOrigin === null ? null : { url: `${config.providerWakeOrigin}/health` },
  },
  connectOrigins: config.providerWakeOrigin === null ? [] : [config.providerWakeOrigin],
  catchUpWindowMin,
  ...(config.webDistDir === null ? {} : { webRoot: config.webDistDir }),
  policy: agent.policyStore,
  mode: 'live',
  schedules,
  scheduler,
  voice: agent.voice,
});
const server = createServer((req, res) => void api.handler(req, res));
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
const host = config.nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1';
server.listen(config.port, host, () => {
  logInfo(`agent API on http://${host}:${config.port} (database migration ${migration.current})`);
  logInfo(
    `  live: Sepolia ENS${scanFrom === undefined ? ' (scan start: searching; set ENS_DISCOVERY_FROM_BLOCK)' : ` from block ${scanFrom}`} · 0G ${agent.zg.network} ${agent.zg.modelId} · Hedera ${agent.hederaNetwork} · run budget ≤ ${agent.policy.maxPerRun} tinybars`,
  );
  logInfo(
    `  CORS ${config.corsOrigin ?? 'off (same origin)'} · trusted proxy hops ${config.trustProxyHops}${allowLocalHttp ? ' · local provider http allowed (development)' : ''}`,
  );
  scheduler.start();
  logInfo(
    agent.auditor === null
      ? '  HCS audit: off (set HCS_TOPIC_ID after pnpm hcs:create-topic)'
      : `  HCS audit: topic ${agent.auditor.topicId} (each settlement and task digest is posted)`,
  );
  const active = schedules.list().filter((x) => x.enabled).length;
  logInfo(
    `  scheduler: ${active} enabled schedule(s), checked every minute (one run per schedule per UTC day)`,
  );
  if (agent.zg.unavailable !== null)
    logError(
      `  0G inference unavailable: ${agent.zg.unavailable}. The site stays up; tasks stop at the 0G plan step (nothing is paid) until it is listed again (checked at most once a minute). Run \`pnpm zg:models\` to see the catalog.`,
    );
  logInfo(
    agent.voice === null
      ? `  voice task: off (${agent.voiceStatus.reason ?? 'not configured'})`
      : `  voice task: ${agent.voiceStatus.model} on 0G (each clip reserves ZG_STT_MAX_NEURON against the daily cap)`,
  );
  if (config.webDistDir !== null) logInfo(`  web app: served at / from ${config.webDistDir}`);
  if (config.databaseEphemeral)
    logInfo(
      `  database: wiped when the host restarts (DATABASE_EPHEMERAL); the daily brief catches up only within ${CATCH_UP_WINDOW_MIN} min of its time`,
    );
  if (!allowLocalHttp && config.nodeEnv !== 'production')
    logInfo(
      '  note: http://127.0.0.1 provider endpoints are refused. If the ENS records point to the local provider service, restart with --allow-local-http.',
    );
});

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logInfo(`${signal}: no new requests; waiting for the running task to finish ...`);
  server.close();
  scheduler.stop();
  api.closeStreams();
  // a payment waiting for approval would hold the task past the shutdown delay: expire it (D-066)
  const expired = agent.approvals.expireAllPending('restart');
  if (expired.length > 0) logInfo(`${expired.length} approval request(s) expired: stopping`);
  const dropped = runner.drop();
  if (dropped.length > 0)
    logInfo(`${dropped.length} waiting task(s) will be cancelled at the next start`);
  void runner.idle().then(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
