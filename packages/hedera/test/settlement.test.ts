import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MirrorTransaction } from '../src/mirror.ts';
import {
  toMirrorTransactionId,
  verifyHbarSettlement,
  verifyTokenSettlement,
  type ExpectedTokenSettlement,
} from '../src/settlement.ts';
import { USDC_TOKEN_ID, formatUsdc } from '../src/units.ts';

const PAYER = '0.0.11044318';
const PAYTO = '0.0.11044329';
const FEE_PAYER = '0.0.7162784';
const TX_ID = `${FEE_PAYER}@1730000000.123456789`;

// Shaped like a Mirror Node CRYPTOTRANSFER where the facilitator's fee payer
// covers network fees (node + staking accounts receive the fee).
const SETTLED: MirrorTransaction = {
  transactionId: `${FEE_PAYER}-1730000000-123456789`,
  result: 'SUCCESS',
  name: 'CRYPTOTRANSFER',
  consensusTimestamp: '1730000002.000000001',
  chargedTxFee: 84_000n,
  transfers: [
    { account: PAYER, amount: -100_000n },
    { account: PAYTO, amount: 100_000n },
    { account: FEE_PAYER, amount: -84_000n },
    { account: '0.0.3', amount: 4_000n },
    { account: '0.0.98', amount: 80_000n },
  ],
};

const expected = { transactionId: TX_ID, payer: PAYER, payTo: PAYTO, amount: 100_000n };

describe('toMirrorTransactionId', () => {
  it('converts the SDK form to the Mirror Node path form', () => {
    assert.equal(toMirrorTransactionId(TX_ID), `${FEE_PAYER}-1730000000-123456789`);
    assert.equal(
      toMirrorTransactionId(`${FEE_PAYER}-1730000000-123456789`),
      `${FEE_PAYER}-1730000000-123456789`,
    );
    assert.throws(() => toMirrorTransactionId('nope'), /0\.0\.N@seconds\.nanos/);
  });
});

describe('verifyHbarSettlement', () => {
  it('accepts an exact, successful transfer', () => {
    const v = verifyHbarSettlement(SETTLED, expected);
    assert.equal(v.ok, true, JSON.stringify(v.checks));
  });

  it('rejects a failed result', () => {
    assert.equal(
      verifyHbarSettlement({ ...SETTLED, result: 'INSUFFICIENT_PAYER_BALANCE' }, expected).ok,
      false,
    );
  });

  it('rejects a different transaction', () => {
    assert.equal(
      verifyHbarSettlement(SETTLED, {
        ...expected,
        transactionId: `${FEE_PAYER}@1730000000.000000001`,
      }).ok,
      false,
    );
  });

  it('rejects an underpayment or an overcharge of the payer', () => {
    const under: MirrorTransaction = {
      ...SETTLED,
      transfers: [
        { account: PAYER, amount: -99_999n },
        { account: PAYTO, amount: 99_999n },
      ],
    };
    assert.equal(verifyHbarSettlement(under, expected).ok, false);

    const payerPaidFees: MirrorTransaction = {
      ...SETTLED,
      transfers: [
        { account: PAYER, amount: -184_000n },
        { account: PAYTO, amount: 100_000n },
        { account: '0.0.98', amount: 84_000n },
      ],
    };
    const v = verifyHbarSettlement(payerPaidFees, expected);
    assert.equal(v.ok, false);
    assert.ok(v.checks.some((c) => c.name.startsWith('payer debited') && !c.ok));
  });

  it('rejects payment to a different account', () => {
    assert.equal(verifyHbarSettlement(SETTLED, { ...expected, payTo: '0.0.999' }).ok, false);
  });

  it('refuses token transfers in an HBAR payment, and consensus before the valid start', () => {
    assert.equal(verifyHbarSettlement({ ...SETTLED, tokenTransferCount: 0 }, expected).ok, true);
    const tokens = verifyHbarSettlement({ ...SETTLED, tokenTransferCount: 1 }, expected);
    assert.ok(tokens.checks.some((c) => c.name.startsWith('no token transfers') && !c.ok));
    const early = verifyHbarSettlement(
      { ...SETTLED, consensusTimestamp: '1729999999.999999999' },
      expected,
    );
    assert.ok(early.checks.some((c) => c.name.startsWith('reached consensus') && !c.ok));
  });
});

describe('verifyTokenSettlement (HTS USDC, D-064)', () => {
  const USDC = USDC_TOKEN_ID.testnet;
  const PAID: MirrorTransaction = {
    ...SETTLED,
    // the payer moves no HBAR: the facilitator pays the fee
    transfers: SETTLED.transfers.filter((t) => t.account !== PAYER && t.account !== PAYTO),
    tokenTransferCount: 2,
    tokenTransfers: [
      { tokenId: USDC, account: PAYER, amount: -10_000n },
      { tokenId: USDC, account: PAYTO, amount: 10_000n },
    ],
  };
  const want: ExpectedTokenSettlement = {
    transactionId: TX_ID,
    payer: PAYER,
    payTo: PAYTO,
    amount: 10_000n,
    tokenId: USDC,
  };

  it('accepts the exact token transfer, with no HBAR from the payer', () => {
    const v = verifyTokenSettlement(PAID, want);
    assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
    assert.equal(v.checks.length, 9);
  });

  it('rejects a wrong amount, payee, token, missing token transfers, HBAR from the payer and failures', () => {
    const bad = (tx: Partial<MirrorTransaction>, over: Partial<typeof want> = {}) =>
      verifyTokenSettlement({ ...PAID, ...tx }, { ...want, ...over }).ok;
    assert.equal(bad({}, { amount: 9_999n }), false);
    assert.equal(bad({}, { payTo: '0.0.666' }), false);
    assert.equal(bad({}, { tokenId: '0.0.456858' }), false);
    assert.equal(bad({ tokenTransfers: [] }), false);
    const noTokens: MirrorTransaction = {
      transactionId: PAID.transactionId,
      result: PAID.result,
      name: PAID.name,
      consensusTimestamp: PAID.consensusTimestamp,
      chargedTxFee: PAID.chargedTxFee,
      transfers: PAID.transfers,
    };
    assert.equal(verifyTokenSettlement(noTokens, want).ok, false);
    assert.equal(
      bad({
        tokenTransfers: [
          ...(PAID.tokenTransfers ?? []),
          { tokenId: '0.0.777', account: PAYER, amount: -1n },
          { tokenId: '0.0.777', account: PAYTO, amount: 1n },
        ],
      }),
      false,
    );
    assert.equal(
      bad({
        transfers: [
          ...PAID.transfers,
          { account: PAYER, amount: -5n },
          { account: '0.0.98', amount: 5n },
        ],
      }),
      false,
    );
    assert.equal(bad({ result: 'INSUFFICIENT_TOKEN_BALANCE' }), false);
    assert.equal(bad({ name: 'TOKENMINT' }), false);
  });

  it('formats USDC exactly', () => {
    assert.equal(formatUsdc(10_000n), '0.01');
    assert.equal(formatUsdc(1_000_000n), '1');
    assert.equal(formatUsdc(1_234_567n), '1.234567');
    assert.equal(formatUsdc(0n), '0');
  });
});
