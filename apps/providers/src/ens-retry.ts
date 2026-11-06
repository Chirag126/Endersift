/**
 * The startup ENS read, tried again when it fails (D-082). A Render cold start
 * reads Sepolia at the same moment the agent does, and a free RPC plan can
 * answer 429 for longer than viem's own backoff; that used to stop the
 * process, so the host never woke. A failed read is tried again after each
 * delay; the last failure still stops startup. A mismatch with ENS is not a
 * failed read: the caller compares the snapshot and refuses as before.
 */
export const ENS_READ_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 30_000];

export async function readEnsWithRetry<T>(
  read: () => Promise<T>,
  options: {
    readonly delaysMs?: readonly number[];
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  } = {},
): Promise<T> {
  const delays = options.delaysMs ?? ENS_READ_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      const delay = delays[attempt - 1];
      if (delay === undefined) throw error;
      options.onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }
}
