/**
 * Watchlist input (CLI and API): comma, semicolon or newline separated, or an
 * array; trimmed, de-duplicated, 1-20 items of at most 100 characters. Pure.
 */
export class WatchlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchlistError';
  }
}

export function parseWatchlist(raw: string | readonly unknown[]): string[] {
  const parts =
    typeof raw === 'string'
      ? raw.split(/[,;\n]/)
      : raw.map((x) => {
          if (typeof x !== 'string') throw new WatchlistError('watchlist items must be strings');
          return x;
        });
  const items = [...new Set(parts.map((s) => s.trim()).filter((s) => s !== ''))];
  if (items.length < 1 || items.length > 20)
    throw new WatchlistError('the watchlist needs 1 to 20 comma-separated items');
  if (items.some((s) => s.length > 100))
    throw new WatchlistError('each watchlist item must be at most 100 characters');
  return items;
}
