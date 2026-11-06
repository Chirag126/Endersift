// Class: unit. Scheduled payments (D-066): the time window, the ID forms and
// the Mirror Node checks of an executed scheduled transfer. No network.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MirrorSchedule, MirrorTransaction } from '../src/mirror.ts';
import { parseMirrorSchedule } from '../src/mirror.ts';
import { scheduleTime, scheduledMirrorId, verifyScheduledPayment } from '../src/schedule.ts';

const PAYER = '0.0.11044318';
const PAYEE = '0.0.11044329';
const NOW = new Date('2026-10-29T10:00:00.000Z');

const schedule = (over: Partial<MirrorSchedule> = {}): MirrorSchedule => ({
  scheduleId: '0.0.7000001',
  creatorAccountId: PAYER,
  payerAccountId: PAYER,
  memo: 'subscription kev',
  deleted: false,
  waitForExpiry: true,
  expirationTime: '1793272800.000000000',
  executedTimestamp: '1793272801.000000001',
  consensusTimestamp: '1793272200.000000001',
  ...over,
});
const executed = (over: Partial<MirrorTransaction> = {}): MirrorTransaction => ({
  transactionId: `${PAYER}-1793272190-000000001`,
  result: 'SUCCESS',
  name: 'CRYPTOTRANSFER',
  consensusTimestamp: '1793272801.000000001',
  chargedTxFee: 90_000n,
  transfers: [
    { account: PAYER, amount: -190_000n },
    { account: PAYEE, amount: 100_000n },
    { account: '0.0.802', amount: 90_000n },
  ],
  tokenTransferCount: 0,
  scheduled: true,
  ...over,
});
const EXPECT = { scheduleId: '0.0.7000001', payer: PAYER, payee: PAYEE, tinybars: 100_000n };

describe('scheduled payments (D-066)', () => {
  it('executes between 2 minutes and 62 days ahead', () => {
    assert.equal(scheduleTime(NOW, { inMinutes: 10 }).toISOString(), '2026-10-29T10:10:00.000Z');
    assert.equal(
      scheduleTime(NOW, { at: '2026-11-01T00:15:00Z' }).toISOString(),
      '2026-11-01T00:15:00.000Z',
    );
    // rounded up to a whole second (the network schedules per second, D-068)
    assert.equal(
      scheduleTime(new Date('2026-10-29T06:00:00.250Z'), {
        at: '2026-10-29T06:09:35.678Z',
      }).toISOString(),
      '2026-10-29T06:09:36.000Z',
    );
    assert.throws(() => scheduleTime(NOW, { inMinutes: 1 }), /at least 2 minutes/);
    assert.throws(() => scheduleTime(NOW, { inMinutes: 62 * 24 * 60 + 1 }), /62 days/);
    assert.throws(() => scheduleTime(NOW, { at: 'soon' }), /not a valid date/);
  });

  it('maps the scheduled transaction ID to its Mirror Node form', () => {
    assert.equal(
      scheduledMirrorId(`${PAYER}@1793272190.000000001?scheduled`),
      `${PAYER}-1793272190-000000001`,
    );
    assert.throws(() => scheduledMirrorId('nope'), /not a transaction ID/);
  });

  it('verified only when it executed as scheduled and moved exactly the amount', () => {
    const ok = verifyScheduledPayment(
      schedule(),
      [executed({ scheduled: false, transfers: [] }), executed()],
      EXPECT,
    );
    assert.ok(
      ok.ok,
      ok.checks
        .filter((c) => !c.ok)
        .map((c) => c.name)
        .join(', '),
    );
    // the owner's live case: executed in its expiration second, 0.6 s before the sub-second part
    const live = verifyScheduledPayment(
      schedule({
        expirationTime: '1793272801.678000000',
        executedTimestamp: '1793272801.069235503',
      }),
      [executed()],
      EXPECT,
    );
    assert.equal(live.ok, true);
    const cases: [string, ReturnType<typeof verifyScheduledPayment>][] = [
      [
        'not yet executed',
        verifyScheduledPayment(schedule({ executedTimestamp: null }), [], EXPECT),
      ],
      ['deleted', verifyScheduledPayment(schedule({ deleted: true }), [executed()], EXPECT)],
      [
        'no wait for expiry',
        verifyScheduledPayment(schedule({ waitForExpiry: false }), [executed()], EXPECT),
      ],
      [
        'failed',
        verifyScheduledPayment(
          schedule(),
          [executed({ result: 'INSUFFICIENT_PAYER_BALANCE' })],
          EXPECT,
        ),
      ],
      [
        'wrong amount',
        verifyScheduledPayment(
          schedule(),
          [
            executed({
              transfers: [
                { account: PAYER, amount: -99_000n },
                { account: PAYEE, amount: 9_000n },
              ],
            }),
          ],
          EXPECT,
        ),
      ],
      ['schedule unknown', verifyScheduledPayment(null, [], EXPECT)],
      [
        'before its time',
        verifyScheduledPayment(
          schedule({ executedTimestamp: '1793272000.0' }),
          [executed()],
          EXPECT,
        ),
      ],
      [
        'a second early',
        verifyScheduledPayment(
          schedule({
            expirationTime: '1793272801.678000000',
            executedTimestamp: '1793272800.999999999',
          }),
          [executed()],
          EXPECT,
        ),
      ],
    ];
    for (const [name, r] of cases) assert.equal(r.ok, false, name);
  });

  it('parses the Mirror Node schedule entity', () => {
    const s = parseMirrorSchedule({
      schedule_id: '0.0.7000001',
      creator_account_id: PAYER,
      payer_account_id: PAYER,
      memo: 'm',
      deleted: false,
      wait_for_expiry: true,
      expiration_time: '1793272800.000000000',
      executed_timestamp: null,
      consensus_timestamp: '1793272200.000000001',
    });
    assert.equal(s.executedTimestamp, null);
    assert.equal(s.waitForExpiry, true);
    assert.throws(() => parseMirrorSchedule({ schedule_id: 'x' }), /schedule_id/);
  });
});
