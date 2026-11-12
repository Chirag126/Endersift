/**
 * NEAR amounts. 1 NEAR = 10^24 yoctoNEAR. Amounts are bigint yoctoNEAR in
 * code and decimal strings on the wire; nothing here uses floating point. Pure.
 */
export const YOCTO_PER_NEAR = 10n ** 24n;

/** "0.005" → 5000000000000000000000n. Rejects signs, exponents and more than 24 decimals. */
export function parseNear(text: string): bigint {
  const m = /^(\d{1,15})(?:\.(\d{1,24}))?$/.exec(text.trim());
  if (m === null) throw new Error('not a NEAR amount: digits with at most 24 decimals');
  const whole = BigInt(m[1] ?? '0');
  const frac = (m[2] ?? '').padEnd(24, '0');
  return whole * YOCTO_PER_NEAR + BigInt(frac);
}

/** A decimal string of yoctoNEAR from JSON → bigint. Rejects anything but plain digits. */
export function parseYocto(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,40}$/.test(value))
    throw new Error('not a yoctoNEAR amount: a string of digits');
  return BigInt(value);
}

/** 5000000000000000000000n → "0.005". Exact: trailing zeros are dropped, nothing is rounded. */
export function formatNear(yocto: bigint): string {
  const sign = yocto < 0n ? '-' : '';
  const abs = yocto < 0n ? -yocto : yocto;
  const whole = abs / YOCTO_PER_NEAR;
  const frac = (abs % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac === '' ? '' : `.${frac}`}`;
}

/** NEAR account id rules (nomicon): 2-64 chars, lowercase parts joined by . with - or _ inside. */
export function isAccountId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 2 &&
    value.length <= 64 &&
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(value)
  );
}
