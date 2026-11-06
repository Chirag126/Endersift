/**
 * Independent settlement verification against the Hedera Mirror Node.
 *
 * A payment is only considered settled when the Mirror Node shows the exact
 * transaction with result SUCCESS, the payee credited exactly the quoted
 * amount, and the payer debited exactly that amount (the facilitator's fee
 * payer covers network fees, so the payer's net movement is the price alone).
 * An HTTP 200 from the paid endpoint, or a facilitator claiming success, is
 * never sufficient on its own.
 */
import type { MirrorTransaction } from './mirror.ts';

export interface ExpectedSettlement {
  readonly transactionId: string;
  readonly payer: string;
  readonly payTo: string;
  /** Exact amount in tinybars (HBAR settlement). */
  readonly amount: bigint;
}

export interface SettlementCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SettlementVerdict {
  readonly ok: boolean;
  readonly checks: readonly SettlementCheck[];
}

/** 0.0.123@1700000000.000000001 → 0.0.123-1700000000-000000001 (Mirror Node path form). */
export function toMirrorTransactionId(transactionId: string): string {
  const match = /^(0\.0\.\d+)@(\d+)\.(\d+)$/.exec(transactionId.trim());
  if (match === null) {
    if (/^0\.0\.\d+-\d+-\d+$/.test(transactionId.trim())) return transactionId.trim();
    throw new Error('transaction ID must look like 0.0.N@seconds.nanos');
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function netHbarFor(tx: MirrorTransaction, account: string): bigint {
  return tx.transfers.filter((t) => t.account === account).reduce((sum, t) => sum + t.amount, 0n);
}

export function verifyHbarSettlement(
  tx: MirrorTransaction,
  expected: ExpectedSettlement,
): SettlementVerdict {
  const checks: SettlementCheck[] = [];
  const wantId = toMirrorTransactionId(expected.transactionId);

  checks.push({
    name: 'transaction ID matches',
    ok: tx.transactionId === wantId,
    detail: `mirror ${tx.transactionId}, expected ${wantId}`,
  });
  checks.push({ name: 'result is SUCCESS', ok: tx.result === 'SUCCESS', detail: tx.result });
  if (tx.tokenTransferCount !== undefined) {
    checks.push({
      name: 'no token transfers (HBAR payment)',
      ok: tx.tokenTransferCount === 0,
      detail: `${tx.tokenTransferCount} token transfer(s)`,
    });
  }
  const start = /@(\d+)\.(\d{9})$/.exec(expected.transactionId.trim());
  const consensus = /^(\d+)\.(\d{1,9})$/.exec(tx.consensusTimestamp);
  if (start !== null && consensus !== null) {
    const startNs = BigInt(start[1] ?? '0') * 1_000_000_000n + BigInt(start[2] ?? '0');
    const consensusNs =
      BigInt(consensus[1] ?? '0') * 1_000_000_000n + BigInt((consensus[2] ?? '0').padEnd(9, '0'));
    checks.push({
      name: 'reached consensus after its valid start',
      ok: consensusNs >= startNs,
      detail: `valid start ${start[1]}.${start[2]}, consensus ${tx.consensusTimestamp}`,
    });
  }
  checks.push({
    name: 'is a crypto transfer',
    ok: tx.name === 'CRYPTOTRANSFER',
    detail: tx.name,
  });

  const credited = netHbarFor(tx, expected.payTo);
  checks.push({
    name: 'payee credited exactly the quoted amount',
    ok: credited === expected.amount,
    detail: `${expected.payTo} net ${credited} tinybars, expected +${expected.amount}`,
  });

  const debited = netHbarFor(tx, expected.payer);
  checks.push({
    name: 'payer debited exactly the quoted amount',
    ok: debited === -expected.amount,
    detail: `${expected.payer} net ${debited} tinybars, expected -${expected.amount}`,
  });

  return { ok: checks.every((c) => c.ok), checks };
}

export interface ExpectedTokenSettlement extends ExpectedSettlement {
  /** HTS token ID, e.g. testnet USDC 0.0.429274. `amount` is in its smallest unit. */
  readonly tokenId: string;
}

function netTokenFor(tx: MirrorTransaction, tokenId: string, account: string): bigint {
  return (tx.tokenTransfers ?? [])
    .filter((t) => t.tokenId === tokenId && t.account === account)
    .reduce((sum, t) => sum + t.amount, 0n);
}

/**
 * An HTS token payment (plan row 37, D-064), checked like an HBAR one: the
 * exact transaction, SUCCESS, a crypto transfer after its valid start, the
 * payee credited and the payer debited exactly the quoted amount of exactly
 * this token. No other token may move, and the payer pays no HBAR (the
 * facilitator's fee payer covers the network fee). Pure.
 */
export function verifyTokenSettlement(
  tx: MirrorTransaction,
  expected: ExpectedTokenSettlement,
): SettlementVerdict {
  const base = verifyHbarSettlement(tx, { ...expected, amount: 0n }).checks.filter(
    (c) =>
      c.name === 'transaction ID matches' ||
      c.name === 'result is SUCCESS' ||
      c.name === 'reached consensus after its valid start' ||
      c.name === 'is a crypto transfer',
  );
  const checks: SettlementCheck[] = [...base];
  const transfers = tx.tokenTransfers;
  checks.push({
    name: 'token transfers reported',
    ok: transfers !== undefined && transfers.length > 0,
    detail: `${transfers?.length ?? 0} token transfer(s)`,
  });
  const others = (transfers ?? []).filter((t) => t.tokenId !== expected.tokenId);
  checks.push({
    name: 'only the quoted token moved',
    ok: others.length === 0,
    detail:
      others.length === 0
        ? expected.tokenId
        : `also ${[...new Set(others.map((t) => t.tokenId))].join(', ')}`,
  });
  const credited = netTokenFor(tx, expected.tokenId, expected.payTo);
  checks.push({
    name: 'payee credited exactly the quoted amount',
    ok: credited === expected.amount,
    detail: `${expected.payTo} net ${credited} of ${expected.tokenId}, expected +${expected.amount}`,
  });
  const debited = netTokenFor(tx, expected.tokenId, expected.payer);
  checks.push({
    name: 'payer debited exactly the quoted amount',
    ok: debited === -expected.amount,
    detail: `${expected.payer} net ${debited} of ${expected.tokenId}, expected -${expected.amount}`,
  });
  const payerHbar = netHbarFor(tx, expected.payer);
  checks.push({
    name: 'payer paid no HBAR',
    ok: payerHbar === 0n,
    detail: `${expected.payer} net ${payerHbar} tinybars`,
  });
  return { ok: checks.every((c) => c.ok), checks };
}
