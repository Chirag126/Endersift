/**
 * A subscription-style payment with Hedera Scheduled Transactions (D-066).
 *
 *   pnpm hedera:schedule-payment                                  dry run
 *   pnpm hedera:schedule-payment -- --confirm [--to kev] [--tinybars 100000] [--in-minutes 10]
 *   pnpm hedera:schedule-payment -- --check 0.0.123456 --save-evidence
 *
 * --confirm schedules ONE HBAR transfer from the payer to a provider's payout
 * account, executed by the network at the chosen time (HIP-423
 * wait_for_expiry), not before. It prints the schedule ID; nothing executes
 * yet. After the time, --check reads the schedule and its execution from the
 * Mirror Node and verifies: executed, SUCCESS, the payee credited exactly the
 * amount, the payer debited it (plus the execution fee).
 *
 * What this is and is not: a recurring-payment building block an owner runs
 * on purpose (one scheduled transfer per period), capped at
 * X402_MAX_PAYMENT_TINYBARS and limited to the providers' own payout
 * accounts. It is not an agent purchase: it does not go through the x402
 * firewall, and the agent's daily x402 budget does not count it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnv, parseLabelledAccounts } from '../../packages/core/src/index.ts';
import {
  MirrorNodeClient,
  hashscanTransactionUrl,
  scheduleTime,
  scheduledMirrorId,
  verifyScheduledPayment,
} from '../../packages/hedera/src/index.ts';
import {
  createClient,
  definiteFailureStatus,
  parsePrivateKey,
  scheduleTransfer,
  type KeyType,
} from '../../packages/hedera/src/sdk.ts';
import {
  UsageError,
  argValue,
  handleScriptErrors,
  hasFlag,
  loadLocalEnvSource,
  writeEvidence,
} from '../lib/cli.ts';

handleScriptErrors();

/** Schedules this script created, so --check knows what was expected (not committed: data/). */
const STATE = 'data/scheduled-payments.json';
interface Recorded {
  readonly scheduleId: string;
  readonly createTransactionId: string;
  readonly scheduledTransactionId: string;
  readonly payer: string;
  readonly payee: string;
  readonly label: string;
  readonly tinybars: string;
  readonly executeAt: string;
  readonly memo: string;
  readonly createdAt: string;
}
const readState = (): Recorded[] =>
  existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as Recorded[]) : [];

const env = loadEnv(['hedera', 'hedera-providers', 'x402'], loadLocalEnvSource());
const network = env.require('HEDERA_NETWORK') as 'testnet' | 'mainnet';
if (network !== 'testnet') throw new UsageError('scheduled payments run on testnet only');
const payer = env.require('HEDERA_PAYER_ACCOUNT_ID');
const mirror = new MirrorNodeClient(env.require('HEDERA_MIRROR_NODE_URL'));

// ── --check: verify a schedule this script created ──────────────────────
const checkId = argValue('--check');
if (checkId !== undefined) {
  const rec = readState().find((r) => r.scheduleId === checkId);
  if (rec === undefined)
    throw new UsageError(`${checkId} was not created by this script on this computer (${STATE})`);
  const schedule = await mirror.getSchedule(rec.scheduleId);
  const executions = await mirror.getTransactions(scheduledMirrorId(rec.scheduledTransactionId));
  const v = verifyScheduledPayment(schedule, executions, {
    scheduleId: rec.scheduleId,
    payer: rec.payer,
    payee: rec.payee,
    tinybars: BigInt(rec.tinybars),
  });
  console.log(
    `Scheduled payment ${rec.scheduleId} (${rec.label}, ${rec.tinybars} tinybars, due ${rec.executeAt})`,
  );
  for (const c of v.checks) console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  const executed = executions.find((t) => t.scheduled === true);
  const hashscan = hashscanTransactionUrl(
    network,
    rec.scheduledTransactionId.replace('?scheduled', ''),
  );
  console.log(`\nHashScan: ${hashscan}`);
  if (hasFlag('--save-evidence')) {
    const path = writeEvidence('hedera', v.ok ? 'scheduled-payment' : 'scheduled-payment-attempt', {
      kind: 'scheduled-payment',
      network,
      scheduleId: rec.scheduleId,
      createTransactionId: rec.createTransactionId,
      scheduledTransactionId: rec.scheduledTransactionId,
      payer: rec.payer,
      payee: rec.payee,
      label: rec.label,
      tinybars: rec.tinybars,
      executeAt: rec.executeAt,
      memo: rec.memo,
      schedule,
      execution: executed ?? null,
      checks: v.checks,
      verified: v.ok,
      hashscan,
      checkedAt: new Date().toISOString(),
    });
    console.log(`Evidence written to ${path}`);
  }
  console.log(v.ok ? '\nEXECUTED AND VERIFIED.' : '\nNOT VERIFIED (yet): see above.');
  if (!v.ok) process.exitCode = 1;
  process.exit();
}

// ── schedule one transfer ────────────────────────────────────────────────
const accounts = parseLabelledAccounts(env.require('HEDERA_PROVIDER_ACCOUNTS'));
if (typeof accounts === 'string') throw new UsageError(`HEDERA_PROVIDER_ACCOUNTS ${accounts}`);
const label = argValue('--to') ?? accounts[0]?.label ?? 'kev';
const payee = accounts.find((a) => a.label === label)?.accountId;
if (payee === undefined)
  throw new UsageError(`--to must be one of ${accounts.map((a) => a.label).join(', ')}`);
const raw = argValue('--tinybars') ?? '100000';
if (!/^[1-9]\d{0,15}$/.test(raw))
  throw new UsageError('--tinybars must be a positive whole number');
const tinybars = BigInt(raw);
const cap = BigInt(env.require('X402_MAX_PAYMENT_TINYBARS'));
if (tinybars > cap) throw new UsageError(`--tinybars is above X402_MAX_PAYMENT_TINYBARS (${cap})`);
const inMinutes = argValue('--in-minutes');
const at = argValue('--at');
const executeAt = scheduleTime(new Date(), {
  ...(at === undefined ? {} : { at }),
  ...(inMinutes === undefined ? { inMinutes: 10 } : { inMinutes: Number(inMinutes) }),
});
const memo = `subscription ${label} ${executeAt.toISOString().slice(0, 16)}Z`;

console.log(
  `Scheduled payment on Hedera ${network} ${hasFlag('--confirm') ? '(CONFIRM)' : '(dry run)'}`,
);
console.log(`  from      ${payer} (the payer; signs the schedule, pays its fees)`);
console.log(`  to        ${payee} (${label})`);
console.log(`  amount    ${tinybars} tinybars`);
console.log(`  executes  ${executeAt.toISOString()} (wait for expiry; cancellable until then)`);
console.log(`  memo      ${memo}`);
if (!hasFlag('--confirm')) {
  console.log('\ndry run: nothing was scheduled. Re-run with -- --confirm.');
  process.exit(0);
}

const key = parsePrivateKey(
  env.require('HEDERA_PAYER_PRIVATE_KEY'),
  env.require('HEDERA_PAYER_KEY_TYPE') as KeyType,
);
const client = createClient(network, payer, key);
let created: Awaited<ReturnType<typeof scheduleTransfer>>;
try {
  created = await scheduleTransfer(client, {
    from: payer,
    to: payee,
    tinybars,
    executeAt,
    memo,
    adminKey: key,
  });
} catch (error) {
  client.close();
  const status = definiteFailureStatus(error);
  throw new UsageError(
    status === null
      ? `schedule outcome unknown: ${error instanceof Error ? error.message : String(error)}. Check the payer's transactions on HashScan before retrying.`
      : `schedule refused by Hedera (${status}); nothing was scheduled.`,
  );
}
client.close();
const record: Recorded = {
  ...created,
  payer,
  payee,
  label,
  tinybars: tinybars.toString(),
  executeAt: executeAt.toISOString(),
  memo,
  createdAt: new Date().toISOString(),
};
mkdirSync('data', { recursive: true });
writeFileSync(STATE, `${JSON.stringify([...readState(), record], null, 2)}\n`, 'utf8');
console.log(`\nscheduled ${created.scheduleId} (create ${created.createTransactionId})`);
console.log(`  executes as ${created.scheduledTransactionId}`);
console.log(`  HashScan: ${hashscanTransactionUrl(network, created.createTransactionId)}`);
console.log(
  `\nAfter ${executeAt.toISOString()}, verify it:\n  pnpm hedera:schedule-payment -- --check ${created.scheduleId} --save-evidence`,
);
