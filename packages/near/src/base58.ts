/** Base58 (Bitcoin alphabet), as NEAR uses for keys, block hashes and transaction hashes. Pure. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = (ALPHABET[Number(n % 58n)] ?? '') + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

export function base58Decode(text: string): Uint8Array {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error('not base58');
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n % 256n));
    n /= 256n;
  }
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}
