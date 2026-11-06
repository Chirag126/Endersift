/**
 * Browser hooks: hash routing, API data with loading and error states, and a
 * task's live event stream (SSE with replay; D-048), and the provider host
 * wake from the browser (D-085).
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, getJson } from './lib/api.ts';
import { isTerminalEvent, mergeEvents } from './lib/timeline.ts';
import type { RunEvent } from './lib/types.ts';
import {
  WAKE_REQUEST_TIMEOUT_MS,
  WAKE_RETRY_MS,
  healthIsUp,
  nextWake,
  type WakeState,
} from './lib/wake.ts';

// ── routing (#/path/segments) ─────────────────────────────────────────────

const subscribeHash = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};
const readHash = () => window.location.hash;

/** The current route as path segments: "#/tasks/abc" → ["tasks", "abc"]. */
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, readHash, () => '');
  return hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter((s) => s !== '')
    .map((s) => decodeURIComponent(s));
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}

// ── API data ──────────────────────────────────────────────────────────────

export interface Loaded<T> {
  readonly data: T | null;
  readonly error: ApiError | null;
  readonly loading: boolean;
  /** When `data` was last fetched successfully (ms), for staleness notices. */
  readonly updatedAt: number | null;
  readonly reload: () => void;
}

/** GET a JSON resource; `path` null waits. Optional polling while the page is visible. */
export function useApi<T>(path: string | null, pollMs?: number): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (path === null) return undefined;
    let alive = true;
    setLoading(true);
    getJson<T>(path)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        setUpdatedAt(Date.now());
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof ApiError ? e : new ApiError(0, 'UNREACHABLE', String(e), null));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [path, tick]);

  useEffect(() => {
    if (pollMs === undefined || path === null) return undefined;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs, path, reload]);

  return { data, error, loading, updatedAt, reload };
}

// ── live events ───────────────────────────────────────────────────────────

/** Every event type the orchestrator records (EventSource needs a listener per type). */
export const EVENT_TYPES = [
  'RUN_STARTED',
  'PROVIDERS_DISCOVERED',
  'CATALOG_READ',
  'INFERENCE_CALLED',
  'PLAN_CREATED',
  'PURCHASE_SKIPPED',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_APPROVAL_REQUESTED',
  'PAYMENT_APPROVAL_DECIDED',
  'PAYMENT_REFUSED',
  'PAYMENT_SETTLED',
  'PAYMENT_UNKNOWN',
  'PAYMENT_FAILED',
  'DATA_FETCHED',
  'DATA_REJECTED',
  'ANALYSIS_COMPLETED',
  'REPORT_WRITTEN',
  'RUN_FINISHED',
  'RUN_FAILED',
] as const;

export type StreamState = 'connecting' | 'live' | 'ended' | 'reconnecting';

/**
 * A task's events: everything recorded so far, then live updates until the
 * run ends. The browser's EventSource reconnects by itself and resumes from
 * the last event ID, so nothing is missed or shown twice.
 */
export function useTaskEvents(taskId: string): {
  readonly events: readonly RunEvent[];
  readonly state: StreamState;
  readonly error: ApiError | null;
  readonly newest: number;
} {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [state, setState] = useState<StreamState>('connecting');
  const [error, setError] = useState<ApiError | null>(null);
  const newest = useRef(-1);

  useEffect(() => {
    let source: EventSource | null = null;
    let alive = true;
    setEvents([]);
    setState('connecting');
    newest.current = -1;
    const add = (incoming: RunEvent[]) => {
      if (incoming.length === 0) return;
      newest.current = Math.max(newest.current, ...incoming.map((e) => e.seq));
      setEvents((current) => mergeEvents(current, incoming));
    };
    getJson<{ events: RunEvent[] }>(`/api/tasks/${encodeURIComponent(taskId)}/events`)
      .then(({ events: initial }) => {
        if (!alive) return;
        add(initial);
        if (initial.some((e) => isTerminalEvent(e.type))) {
          setState('ended');
          return;
        }
        source = new EventSource(
          `/api/tasks/${encodeURIComponent(taskId)}/stream?after=${newest.current}`,
        );
        source.onopen = () => setState('live');
        source.onerror = () => setState((s) => (s === 'ended' ? s : 'reconnecting'));
        for (const type of EVENT_TYPES)
          source.addEventListener(type, (m) => {
            try {
              add([JSON.parse((m as MessageEvent<string>).data) as RunEvent]);
            } catch {
              // a malformed message is ignored; the next replay fills the gap
            }
          });
        source.addEventListener('end', () => {
          setState('ended');
          source?.close();
        });
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof ApiError ? e : null);
      });
    return () => {
      alive = false;
      source?.close();
    };
  }, [taskId]);

  return { events, state, error, newest: newest.current };
}

/** Copy text to the clipboard; returns whether it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ── provider host wake (D-085) ────────────────────────────────────────────

/**
 * Ask the provider host's /health from this browser, which starts a sleeping
 * Render free host, and say whether it is up. `url` null: nothing is asked.
 */
export function useProviderWake(url: string | null): WakeState {
  const [state, setState] = useState<WakeState>(url === null ? 'off' : 'waking');
  useEffect(() => {
    if (url === null) {
      setState('off');
      return undefined;
    }
    let alive = true;
    let timer: number | undefined;
    let failingSince: number | null = null;
    const ask = async () => {
      if (!alive) return;
      if (document.visibilityState !== 'visible') {
        timer = window.setTimeout(() => void ask(), WAKE_RETRY_MS);
        return;
      }
      let up = false;
      try {
        const res = await fetch(url, {
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.timeout(WAKE_REQUEST_TIMEOUT_MS),
        });
        up = healthIsUp(res.status, await res.json().catch(() => null));
      } catch {
        up = false;
      }
      if (!alive) return;
      const now = Date.now();
      if (up) failingSince = null;
      else failingSince ??= now;
      const next = nextWake(up, failingSince === null ? 0 : now - failingSince);
      setState(next.state);
      if (next.againMs !== null) timer = window.setTimeout(() => void ask(), next.againMs);
    };
    setState('waking');
    void ask();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [url]);
  return state;
}
