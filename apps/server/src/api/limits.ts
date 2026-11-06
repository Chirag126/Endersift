/**
 * Rate limits and connection caps for the API (plan row 26, D-048). In memory,
 * per process: one API instance per database (renderremains.md).
 *
 * `FixedWindowLimiter` counts hits per key in fixed windows; `take()` says
 * whether a hit is allowed and, if not, how long until the window resets.
 * `ConnectionCounter` caps concurrent long-lived connections (SSE).
 */
export interface LimitDecision {
  readonly allowed: boolean;
  /** Seconds until the window resets (for Retry-After); 0 when allowed. */
  readonly retryAfterSec: number;
  readonly remaining: number;
}

export class FixedWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, { start: number; count: number }>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('limit must be a positive integer');
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  #entry(key: string): { start: number; count: number } {
    const t = this.#now();
    let e = this.#hits.get(key);
    if (e === undefined || t - e.start >= this.#windowMs) {
      e = { start: t, count: 0 };
      this.#hits.set(key, e);
    }
    if (this.#hits.size > 10_000) this.#sweep(t);
    return e;
  }

  #sweep(t: number): void {
    for (const [k, e] of this.#hits) if (t - e.start >= this.#windowMs) this.#hits.delete(k);
  }

  #decision(e: { start: number; count: number }, allowed: boolean): LimitDecision {
    return {
      allowed,
      retryAfterSec: allowed
        ? 0
        : Math.max(1, Math.ceil((e.start + this.#windowMs - this.#now()) / 1000)),
      remaining: Math.max(0, this.#limit - e.count),
    };
  }

  /** Count one hit if allowed. */
  take(key: string): LimitDecision {
    const e = this.#entry(key);
    if (e.count >= this.#limit) return this.#decision(e, false);
    e.count += 1;
    return this.#decision(e, true);
  }

  /** Whether a hit would be allowed, without counting it. */
  peek(key: string): LimitDecision {
    const e = this.#entry(key);
    return this.#decision(e, e.count < this.#limit);
  }
}

export class ConnectionCounter {
  readonly #perKey: number;
  readonly #total: number;
  readonly #open = new Map<string, number>();
  #all = 0;

  constructor(perKey: number, total: number) {
    this.#perKey = perKey;
    this.#total = total;
  }

  /** Reserve a slot; returns a release function, or null when full. */
  acquire(key: string): (() => void) | null {
    const n = this.#open.get(key) ?? 0;
    if (n >= this.#perKey || this.#all >= this.#total) return null;
    this.#open.set(key, n + 1);
    this.#all += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const m = (this.#open.get(key) ?? 1) - 1;
      if (m <= 0) this.#open.delete(key);
      else this.#open.set(key, m);
      this.#all -= 1;
    };
  }

  get open(): number {
    return this.#all;
  }
}
