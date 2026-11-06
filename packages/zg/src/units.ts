/** 0G amounts: 1 0G = 1e18 neuron. Exact bigint maths, no floating point. */

export const NEURON_PER_ZG = 10n ** 18n;

/** Format neuron as a decimal 0G string, trimming trailing zeros: 1500000000000000n → "0.0015". */
export function formatZg(neuron: bigint): string {
  const negative = neuron < 0n;
  const abs = negative ? -neuron : neuron;
  const whole = abs / NEURON_PER_ZG;
  const fraction = (abs % NEURON_PER_ZG).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * Parse a non-negative neuron amount from a JSON value. Integer strings and
 * safe integers are exact. Larger JSON numbers have already lost precision in
 * JSON.parse, so they are converted but flagged inexact; anything else throws.
 */
export function parseNeuron(value: unknown, field: string): { neuron: bigint; exact: boolean } {
  if (typeof value === 'string' && /^\d+$/.test(value))
    return { neuron: BigInt(value), exact: true };
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return { neuron: BigInt(value), exact: Number.isSafeInteger(value) };
  }
  throw new Error(`${field} is not a non-negative integer neuron amount`);
}

/**
 * Parse a per-token price (neuron per token). Prices may be fractional, so the
 * result is rounded UP: a cost cap computed from it can only be conservative.
 */
export function parsePriceCeil(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${field} is not a price`);
    return BigInt(Math.ceil(value));
  }
  if (typeof value !== 'string') throw new Error(`${field} is not a price`);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) {
    // Exponent form such as "1.5e-7": value is tiny or large but well defined; round up.
    if (/^\d+(?:\.\d+)?[eE][+-]?\d+$/.test(value.trim())) {
      const n = Number(value.trim());
      if (Number.isFinite(n) && n >= 0) return BigInt(Math.ceil(n));
    }
    throw new Error(`${field} is not a non-negative decimal price`);
  }
  const whole = BigInt(match[1] ?? '0');
  const fraction = match[2] ?? '';
  return /[1-9]/.test(fraction) ? whole + 1n : whole;
}
