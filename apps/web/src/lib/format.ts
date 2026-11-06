/**
 * Exact formatting of money and identifiers. Amounts arrive as integer strings;
 * they are converted with bigint arithmetic, never floats. Pure.
 */

const TINYBARS_PER_HBAR = 100_000_000n;
const NEURON_PER_0G = 1_000_000_000_000_000_000n;

function decimal(atomic: string | bigint, unit: bigint, maxDecimals: number): string {
  const v = typeof atomic === 'bigint' ? atomic : BigInt(atomic);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / unit;
  const digits = unit.toString().length - 1;
  let frac = (abs % unit).toString().padStart(digits, '0').slice(0, maxDecimals);
  frac = frac.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${frac === '' ? '' : `.${frac}`}`;
}

/** "100000" → "0.001" (exact; HBAR has 8 decimals). */
export const hbar = (tinybars: string | bigint): string => decimal(tinybars, TINYBARS_PER_HBAR, 8);

/** "1326974000000000" → "0.001326974" 0G (up to 9 decimals shown). */
export const zg = (neuron: string | bigint): string => decimal(neuron, NEURON_PER_0G, 9);

/**
 * A 0G amount with its unit (D-083). An amount too small to show in 0G at 9
 * decimals (under 10^9 neuron, as 0G bills calls paid from credits) is shown in
 * neuron, exactly, so a real bill never reads "0 0G".
 */
export function zgAmount(neuron: string | bigint): string {
  const v = typeof neuron === 'bigint' ? neuron : BigInt(neuron);
  const abs = v < 0n ? -v : v;
  if (abs > 0n && abs < 1_000_000_000n) return `${grouped(v)} neuron`;
  return `${zg(v)} 0G`;
}

/** Integer-string grouping: "1000000" → "1,000,000". */
export function grouped(n: string | number | bigint): string {
  return BigInt(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Parse an HBAR amount typed by a person into tinybars. Up to 8 decimals,
 * no sign, no exponent. Returns null when it is not such a number.
 */
export function parseHbar(input: string): bigint | null {
  const m = /^\s*(\d{1,10})(?:[.,](\d{1,8}))?\s*$/.exec(input);
  if (m === null) return null;
  return BigInt(m[1] ?? '0') * TINYBARS_PER_HBAR + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
}

/** Long identifiers shortened in the middle: "0.0.7162784@1793113618.672975790" stays; hashes shrink. */
export function middle(id: string, keep = 10): string {
  return id.length <= keep * 2 + 1 ? id : `${id.slice(0, keep)}…${id.slice(-keep + 2)}`;
}

/** "2026-10-27T15:07:29.839Z" → "27 Oct, 15:07:29 UTC". */
export function utcTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month}, ${d.toISOString().slice(11, 19)} UTC`;
}

/** Share of a limit used, 0-100, rounded down; null when the limit is zero or absent. */
export function percentOf(used: string | bigint, limit: string | bigint | null): number | null {
  if (limit === null) return null;
  const l = BigInt(limit);
  if (l <= 0n) return null;
  const u = BigInt(used);
  const p = (u * 100n) / l;
  return Number(p > 100n ? 100n : p);
}

/**
 * The status bar's network label (D-083): "Live on testnets" only while every
 * network is a testnet; 0G on mainnet is named.
 */
export function liveNetworksLabel(networks: {
  readonly hedera: string;
  readonly zg: string;
}): string {
  if (networks.zg === 'mainnet' && networks.hedera === 'mainnet') return 'Live on mainnet';
  if (networks.zg === 'mainnet') return 'Live: 0G mainnet, Hedera and ENS testnets';
  if (networks.hedera === 'mainnet') return 'Live: Hedera mainnet, ENS and 0G testnets';
  return 'Live on testnets';
}
