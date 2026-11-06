/**
 * Subscription-style payments with Hedera Scheduled Transactions (D-066):
 * the pure checks. The SDK call is `scheduleTransfer` in sdk.ts.
 *
 * A scheduled transfer executes at its expiration time (HIP-423,
 * wait_for_expiry), at most 62 days ahead (5,356,800 s, docs.hedera.com,
 * "Scheduled Transaction"). The execution is a separate transaction whose ID
 * is the ScheduleCreate's ID with the scheduled flag; the payer of the
 * ScheduleCreate also pays the execution's fee, so its debit is the amount
 * plus that fee, while the payee must be credited exactly the amount.
 *
 * Expiry is kept per consensus SECOND (D-068): the network buckets schedules
 * by expiration second (HIP-1215 `hasScheduleCapacity(expirySecond, …)`), and
 * the owner's live schedule `0.0.11219239` executed at 1793254175.069 for an
 * expiration of 1793254175.678, i.e. in its expiration second. So this module
 * schedules on whole seconds and checks execution at second granularity.
 */
import type { MirrorSchedule, MirrorTransaction } from './mirror.ts';

export const MAX_SCHEDULE_SECONDS = 5_356_800;
/** The earliest execution this project schedules: enough for the create to reach consensus. */
export const MIN_SCHEDULE_SECONDS = 120;

/** The whole consensus second of a Mirror Node timestamp ("S.N"). Pure. */
const secondOf = (timestamp: string): bigint => BigInt(timestamp.split('.')[0] ?? '0');

/** The execution time for "in N minutes" or an ISO time; throws outside [2 min, 62 days]. Pure. */
export function scheduleTime(
  now: Date,
  input: { readonly inMinutes?: number; readonly at?: string },
): Date {
  const at =
    input.at !== undefined
      ? new Date(input.at)
      : new Date(now.getTime() + (input.inMinutes ?? 5) * 60_000);
  if (Number.isNaN(at.getTime())) throw new RangeError('the execution time is not a valid date');
  const ahead = (at.getTime() - now.getTime()) / 1000;
  if (ahead < MIN_SCHEDULE_SECONDS)
    throw new RangeError(
      `the execution time must be at least ${MIN_SCHEDULE_SECONDS / 60} minutes ahead`,
    );
  if (ahead > MAX_SCHEDULE_SECONDS)
    throw new RangeError('the execution time must be at most 62 days ahead');
  // whole seconds: the network schedules per second, so a sub-second part only misleads
  return new Date(Math.ceil(at.getTime() / 1000) * 1000);
}

/** `0.0.N@S.N?scheduled` (SDK form) → `0.0.N-S-N` (Mirror Node form, query scheduled=true). */
export function scheduledMirrorId(sdkScheduledId: string): string {
  const m = /^(0\.0\.\d+)@(\d+)\.(\d+)(\?scheduled)?$/.exec(sdkScheduledId);
  if (m === null) throw new Error(`not a transaction ID: ${sdkScheduledId}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export interface ScheduledPaymentCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Did the scheduled payment execute as scheduled? From the Mirror Node only:
 * the schedule entity and the executed transfer. Pure.
 */
export function verifyScheduledPayment(
  schedule: MirrorSchedule | null,
  executions: readonly MirrorTransaction[],
  expected: {
    readonly scheduleId: string;
    readonly payer: string;
    readonly payee: string;
    readonly tinybars: bigint;
  },
): { readonly ok: boolean; readonly checks: readonly ScheduledPaymentCheck[] } {
  const checks: ScheduledPaymentCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  add('schedule found', schedule !== null, schedule?.scheduleId ?? 'not on the Mirror Node');
  add(
    'waits for its expiration time',
    schedule?.waitForExpiry === true,
    String(schedule?.waitForExpiry ?? null),
  );
  add('not deleted', schedule !== null && !schedule.deleted, String(schedule?.deleted ?? null));
  add(
    'executed',
    schedule !== null && schedule.executedTimestamp !== null,
    schedule?.executedTimestamp ?? 'not yet',
  );
  const tx = executions.find((t) => t.scheduled === true) ?? null;
  add('execution found', tx !== null, tx?.transactionId ?? 'none with scheduled=true');
  add('result is SUCCESS', tx?.result === 'SUCCESS', tx?.result ?? '-');
  add('is a crypto transfer', tx?.name === 'CRYPTOTRANSFER', tx?.name ?? '-');
  const net = (account: string) =>
    (tx?.transfers ?? []).filter((t) => t.account === account).reduce((s, t) => s + t.amount, 0n);
  add(
    'payee credited exactly the amount',
    tx !== null && net(expected.payee) === expected.tinybars,
    `${expected.payee} net ${net(expected.payee)}, expected +${expected.tinybars}`,
  );
  add(
    'payer debited the amount (plus the fee)',
    tx !== null && net(expected.payer) <= -expected.tinybars,
    `${expected.payer} net ${net(expected.payer)}`,
  );
  add(
    'no token transfers',
    (tx?.tokenTransferCount ?? 0) === 0,
    String(tx?.tokenTransferCount ?? 0),
  );
  if (schedule !== null && schedule.executedTimestamp !== null && schedule.expirationTime !== null)
    add(
      'executed in or after its expiration second',
      secondOf(schedule.executedTimestamp) >= secondOf(schedule.expirationTime),
      `expiration ${schedule.expirationTime}, executed ${schedule.executedTimestamp}`,
    );
  return { ok: checks.every((c) => c.ok), checks };
}
