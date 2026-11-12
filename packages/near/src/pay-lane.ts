/**
 * Paying for one HTTP request through the guard contract.
 *
 * The provider answers an unpaid request with HTTP 402 and a quote:
 *
 *   { scheme: "near-guard", network, guard, payTo, amount, nonce, expiresAt }
 *
 * The agent pays `amount` to `payTo` through the guard contract with the
 * quote's nonce as the receipt memo, and asks again with the header
 *
 *   x-near-payment: <nonce>:<receipt id>
 *
 * The provider reads that receipt from the guard contract and serves the
 * data only when the receipt is Paid, names it as receiver, covers the price
 * and carries the nonce it issued. A nonce is used once, so a receipt cannot
 * be replayed.
 *
 * This file is the protocol, with no I/O: the provider's quote book and
 * check, and the buyer's quote parser.
 */
import type { GuardReceipt } from './guard.ts';
import { clean, isRecord } from './rpc.ts';
import { isAccountId, parseYocto } from './units.ts';

export const NEAR_GUARD_SCHEME = 'near-guard';
export const NEAR_PAYMENT_HEADER = 'x-near-payment';
export type NearNetwork = 'near:testnet' | 'near:mainnet';

export interface NearQuote {
  readonly scheme: typeof NEAR_GUARD_SCHEME;
  readonly network: NearNetwork;
  /** The guard contract the payment must go through. */
  readonly guard: string;
  readonly payTo: string;
  /** yoctoNEAR. */
  readonly amount: bigint;
  readonly nonce: string;
  readonly expiresAt: string;
}

export function quoteJson(quote: NearQuote): Record<string, string> {
  return { ...quote, amount: quote.amount.toString() };
}

/** The buyer's side: read a quote out of a 402 body, checking every field. */
export function parseQuote(body: unknown): NearQuote {
  const accepts = isRecord(body) ? body['accepts'] : undefined;
  const q = Array.isArray(accepts)
    ? accepts.find((a: unknown) => isRecord(a) && a['scheme'] === NEAR_GUARD_SCHEME)
    : undefined;
  if (!isRecord(q)) throw new Error('the 402 answer has no near-guard quote');
  const network = q['network'];
  if (network !== 'near:testnet' && network !== 'near:mainnet')
    throw new Error('the quote names an unknown network');
  if (!isAccountId(q['guard']) || !isAccountId(q['payTo']))
    throw new Error('the quote names a malformed account');
  const nonce = q['nonce'];
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce))
    throw new Error('the quote has a malformed nonce');
  const expiresAt = q['expiresAt'];
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))
    throw new Error('the quote has a malformed expiry');
  return {
    scheme: NEAR_GUARD_SCHEME,
    network,
    guard: q['guard'],
    payTo: q['payTo'],
    amount: parseYocto(q['amount']),
    nonce,
    expiresAt: clean(expiresAt, 40),
  };
}

export function paymentHeader(nonce: string, receiptId: number): string {
  return `${nonce}:${receiptId}`;
}

export function parsePaymentHeader(
  value: string | undefined | null,
): { readonly nonce: string; readonly receiptId: number } | null {
  const m = /^([0-9a-f]{32}):(\d{1,9})$/.exec(value ?? '');
  return m === null ? null : { nonce: m[1] ?? '', receiptId: Number(m[2]) };
}

interface Issued {
  readonly resource: string;
  readonly payTo: string;
  readonly amount: bigint;
  readonly expiresAtMs: number;
}

export interface QuoteBookOptions {
  readonly network: NearNetwork;
  readonly guard: string;
  /** How long a quote can be paid and redeemed. */
  readonly ttlMs?: number;
  /** Most quotes kept at once; the oldest are dropped first. */
  readonly max?: number;
  readonly now?: () => number;
  /** 16 random bytes as 32 hex characters. */
  readonly nonce: () => string;
}

export type RedeemResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The provider's side: the quotes it issued and has not yet served. In memory. */
export class QuoteBook {
  readonly #issued = new Map<string, Issued>();
  readonly #options: Required<Omit<QuoteBookOptions, 'nonce'>> & Pick<QuoteBookOptions, 'nonce'>;

  constructor(options: QuoteBookOptions) {
    this.#options = {
      ttlMs: 10 * 60_000,
      max: 2000,
      now: () => Date.now(),
      ...options,
    };
  }

  get size(): number {
    return this.#issued.size;
  }

  /** A fresh quote for one request to `resource` (the path and query). */
  issue(resource: string, payTo: string, amount: bigint): NearQuote {
    const now = this.#options.now();
    for (const [nonce, q] of this.#issued) if (q.expiresAtMs <= now) this.#issued.delete(nonce);
    while (this.#issued.size >= this.#options.max) {
      const oldest = this.#issued.keys().next();
      if (oldest.done === true) break;
      this.#issued.delete(oldest.value);
    }
    const nonce = this.#options.nonce();
    if (!/^[0-9a-f]{32}$/.test(nonce) || this.#issued.has(nonce))
      throw new Error('nonce source returned an unusable nonce');
    const expiresAtMs = now + this.#options.ttlMs;
    this.#issued.set(nonce, { resource, payTo, amount, expiresAtMs });
    return {
      scheme: NEAR_GUARD_SCHEME,
      network: this.#options.network,
      guard: this.#options.guard,
      payTo,
      amount,
      nonce,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  /**
   * Does this receipt pay the quote with this nonce, for this resource?
   * Does not consume the quote: call `consume` once the data has been served,
   * so a buyer whose request failed upstream can ask again with the same receipt.
   */
  check(nonce: string, resource: string, receipt: GuardReceipt | null): RedeemResult {
    const q = this.#issued.get(nonce);
    if (q === undefined) return { ok: false, reason: 'unknown or already used quote' };
    if (q.expiresAtMs <= this.#options.now()) return { ok: false, reason: 'the quote expired' };
    if (q.resource !== resource) return { ok: false, reason: 'the quote is for another request' };
    if (receipt === null) return { ok: false, reason: 'no such receipt in the guard contract' };
    if (receipt.status !== 'Paid')
      return { ok: false, reason: `the receipt is ${receipt.status.toLowerCase()}, not paid` };
    if (receipt.receiver !== q.payTo)
      return { ok: false, reason: 'the receipt pays another account' };
    if (receipt.amount < q.amount)
      return { ok: false, reason: 'the receipt pays less than the price' };
    if (receipt.memo !== nonce) return { ok: false, reason: 'the receipt is for another quote' };
    return { ok: true };
  }

  consume(nonce: string): void {
    this.#issued.delete(nonce);
  }
}
