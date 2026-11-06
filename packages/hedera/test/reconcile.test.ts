// Class: unit. Mirror-Node reconciliation verdicts for payments whose outcome is unknown.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMirrorTransactions, type MirrorTransaction } from '../src/mirror.ts';
import { reconcileWithMirror, validStartMs } from '../src/reconcile.ts';

const PAYER = '0.0.11044318';
const PAYTO = '0.0.11044329';
const FEE_PAYER = '0.0.7162784';
const TX_ID = `${FEE_PAYER}@1793050556.369688880`;
const MIRROR_ID = `${FEE_PAYER}-1793050556-369688880`;
const START = '2026-10-26T21:35:56.369Z';
const after = (sec: number) => new Date(Date.parse(START) + sec * 1000).toISOString();

const tx = (over: Partial<MirrorTransaction> = {}): MirrorTransaction => ({
  transactionId: MIRROR_ID,
  result: 'SUCCESS',
  name: 'CRYPTOTRANSFER',
  consensusTimestamp: '1793050558.000000001',
  chargedTxFee: 84_000n,
  transfers: [
    { account: PAYER, amount: -100_000n },
    { account: PAYTO, amount: 100_000n },
    { account: FEE_PAYER, amount: -84_000n },
    { account: '0.0.98', amount: 84_000n },
  ],
  ...over,
});

const expected = { transactionId: TX_ID, payer: PAYER, payTo: PAYTO, amount: 100_000n };
const verdict = (entries: MirrorTransaction[], now = after(10)) =>
  reconcileWithMirror({ expected, entries, now });

describe('reconcileWithMirror', () => {
  it('SETTLED when a SUCCESS entry matches payee, payer and amount exactly', () => {
    assert.equal(verdict([tx()]).outcome, 'SETTLED');
  });

  it('finds the matching entry among duplicates', () => {
    const dup = tx({ result: 'DUPLICATE_TRANSACTION', transfers: [] });
    assert.equal(verdict([dup, tx()]).outcome, 'SETTLED');
  });

  it('MISMATCH (never settled, never re-signed) when money moved differently', () => {
    const wrong = tx({
      transfers: [
        { account: PAYER, amount: -100_000n },
        { account: '0.0.666', amount: 100_000n },
      ],
    });
    const v = verdict([wrong]);
    assert.equal(v.outcome, 'MISMATCH');
    assert.ok(v.outcome === 'MISMATCH' && v.checks.some((c) => !c.ok));
  });

  it('FAILED with the consensus result when no entry succeeded', () => {
    const v = verdict([tx({ result: 'INSUFFICIENT_PAYER_BALANCE', transfers: [] })]);
    assert.deepEqual(
      v.outcome === 'FAILED' ? v.code : v.outcome,
      'TX_RESULT_INSUFFICIENT_PAYER_BALANCE',
    );
  });

  it('PENDING while the validity window is open, FAILED once it has closed', () => {
    assert.equal(verdict([], after(299)).outcome, 'PENDING');
    const v = verdict([], after(301));
    assert.equal(v.outcome === 'FAILED' ? v.code : v.outcome, 'TX_EXPIRED_NOT_FOUND');
  });

  it('ignores entries for another transaction ID', () => {
    const other = tx({ transactionId: `${FEE_PAYER}-1793050556-000000001` });
    assert.equal(verdict([other], after(10)).outcome, 'PENDING');
  });

  it('reads the valid start from the transaction ID', () => {
    assert.equal(validStartMs(TX_ID), Date.parse(START));
    assert.throws(() => validStartMs('0.0.1-1-1'));
  });

  it('parses every Mirror Node entry, not only the first', () => {
    const body = {
      transactions: [
        {
          transaction_id: MIRROR_ID,
          result: 'DUPLICATE_TRANSACTION',
          name: 'CRYPTOTRANSFER',
          consensus_timestamp: '1.1',
          charged_tx_fee: 0,
          transfers: [],
        },
        {
          transaction_id: MIRROR_ID,
          result: 'SUCCESS',
          name: 'CRYPTOTRANSFER',
          consensus_timestamp: '1.2',
          charged_tx_fee: 84000,
          transfers: [{ account: PAYTO, amount: 100000 }],
        },
      ],
    };
    assert.deepEqual(
      parseMirrorTransactions(body).map((t) => t.result),
      ['DUPLICATE_TRANSACTION', 'SUCCESS'],
    );
  });

  it('UNVERIFIABLE for another network than the Mirror Node, or a non-HBAR asset', () => {
    const run = (network: string, asset: string) =>
      reconcileWithMirror({
        expected,
        entries: [tx()],
        now: after(10),
        payment: { network, asset },
        mirrorNetwork: 'testnet',
      });
    assert.equal(run('hedera:testnet', '0.0.0').outcome, 'SETTLED');
    const net = run('hedera:mainnet', '0.0.0');
    assert.equal(net.outcome === 'UNVERIFIABLE' ? net.code : net.outcome, 'NETWORK_MISMATCH');
    const asset = run('hedera:testnet', '0.0.456858');
    assert.equal(
      asset.outcome === 'UNVERIFIABLE' ? asset.code : asset.outcome,
      'UNSUPPORTED_ASSET',
    );
  });
});
