/**
 * Retry for READ-ONLY chain calls hit by a provider's rate limit (D-054).
 * ENS discovery is a pure read (eth_getLogs, eth_call): running it again
 * cannot spend anything or change state, so a short, bounded retry on a
 * rate-limit answer is safe. Payments and 0G calls are never retried
 * (D-020, D-042); this helper is not for them.
 */

/** A provider said "too many requests" (Alchemy compute units, HTTP 429, JSON-RPC -32005). */
export function isRateLimited(error: unknown): boolean {
  const text =
    error instanceof Error ? `${error.message} ${String(error.cause ?? '')}` : String(error);
  return /compute units per second|rate.?limit|too many requests|\b429\b|-32005|limit exceeded/i.test(
    text,
  );
}

export interface ReadRetryOptions {
  /** Attempts in total, including the first. */
  readonly attempts?: number;
  /** Delay before the first retry; doubled each time. */
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (attempt: number, delayMs: number) => void;
}

export async function retryReadOnRateLimit<T>(
  read: () => Promise<T>,
  o: ReadRetryOptions = {},
): Promise<T> {
  const attempts = o.attempts ?? 4;
  const base = o.baseDelayMs ?? 1500;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= attempts || !isRateLimited(error)) throw error;
      const delay = base * 2 ** (attempt - 1);
      o.onRetry?.(attempt, delay);
      await sleep(delay);
    }
  }
}
