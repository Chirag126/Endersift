/**
 * Sepolia writes that survive an RPC rate limit (HTTP 429) without ever
 * sending two transactions (D-067).
 *
 * Every attempt of one step is signed with the SAME nonce, read once before
 * the first attempt. Only one transaction per nonce can ever be mined, so a
 * retry can never execute a step twice, even when a rate-limited answer hid
 * a broadcast that did go through. Anything other than a rate limit is
 * thrown at once (no blind retry, D-020/D-042).
 */

const RATE_LIMIT = /\b429\b|rate.?limit|too many requests|compute units|exceeded .*capacity/i;

/** Is this error (or one it wraps) an RPC rate limit? Pure. */
export function isRateLimit(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; depth < 6 && e !== undefined && e !== null; depth++) {
    if (e instanceof Error) {
      if (RATE_LIMIT.test(e.message)) return true;
      const status = (e as { status?: unknown }).status;
      if (status === 429) return true;
      e = (e as { cause?: unknown }).cause;
    } else return typeof e === 'string' && RATE_LIMIT.test(e);
  }
  return false;
}

export class AmbiguousSendError extends Error {
  override readonly name = 'AmbiguousSendError';
}

export interface FixedNonceOptions<T> {
  /** The pending nonce of the sender, read once. */
  readonly nonce: () => Promise<number>;
  /** Sign and broadcast with exactly this nonce. */
  readonly write: (nonce: number) => Promise<T>;
  /** Waits between attempts (default 2 s, 5 s, 10 s). */
  readonly delaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

/** One step, retried on rate limits only, always with the same nonce. */
export async function writeWithFixedNonce<T>(o: FixedNonceOptions<T>): Promise<T> {
  const delays = o.delaysMs ?? [2_000, 5_000, 10_000];
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nonce = await o.nonce();
  for (let attempt = 0; ; attempt++) {
    try {
      return await o.write(nonce);
    } catch (error) {
      const wait = delays[attempt];
      if (!isRateLimit(error)) {
        // after a rate-limited attempt, "already known" / "nonce too low" can mean it went through
        if (attempt > 0)
          throw new AmbiguousSendError(
            `a rate-limited attempt with nonce ${nonce} may have been sent; check the sender on Etherscan before running again (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
          );
        throw error;
      }
      if (wait === undefined)
        throw new AmbiguousSendError(
          `still rate-limited after ${attempt + 1} attempts with nonce ${nonce}; check the sender on Etherscan before running again`,
        );
      o.log?.(
        `  rate-limited by the RPC; retrying in ${wait / 1000} s with the same nonce ${nonce}`,
      );
      await sleep(wait);
    }
  }
}
