/** Human approval helpers (D-066): the countdown from a request's own expiry time. Pure. */

/** Seconds until `iso`, at least 0 (0 for an unreadable time). */
export function secondsLeft(iso: string, nowMs: number): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.floor((at - nowMs) / 1000)) : 0;
}

/** "4 min 05 s" / "35 s". */
export function countdownText(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m === 0 ? `${s} s` : `${m} min ${String(s).padStart(2, '0')} s`;
}
