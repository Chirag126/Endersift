/**
 * Exact HBAR / tinybar conversion using bigint. Floating point is never used
 * for amounts anywhere in this project.
 */

export const TINYBARS_PER_HBAR = 100_000_000n;

/** Format tinybars as an HBAR decimal string without precision loss, e.g. 150000000n → "1.5". */
export function formatHbar(tinybars: bigint): string {
  const negative = tinybars < 0n;
  const abs = negative ? -tinybars : tinybars;
  const whole = abs / TINYBARS_PER_HBAR;
  const fraction = (abs % TINYBARS_PER_HBAR).toString().padStart(8, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/** Parse an HBAR decimal string (max 8 fractional digits) into tinybars. */
export function parseHbar(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value.trim());
  if (match === null) {
    throw new Error('HBAR amount must be a non-negative decimal with at most 8 fractional digits');
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(8, '0'));
  return whole * TINYBARS_PER_HBAR + fraction;
}

/** Circle's USDC on Hedera (developers.circle.com, USDC contract addresses; D-064). */
export const USDC_TOKEN_ID = { testnet: '0.0.429274', mainnet: '0.0.456858' } as const;
export const USDC_DECIMALS = 6;
const USDC_UNIT = 1_000_000n;

/** Exact decimal USDC for an atomic amount (6 decimals), trailing zeros trimmed. */
export function formatUsdc(atomic: bigint): string {
  const sign = atomic < 0n ? '-' : '';
  const abs = atomic < 0n ? -atomic : atomic;
  const whole = abs / USDC_UNIT;
  const frac = (abs % USDC_UNIT).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac === '' ? '' : `.${frac}`}`;
}
