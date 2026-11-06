/**
 * The UI theme (Phase UI toggle): Classic (the original look, the default),
 * Electric (black, cobalt and acid lime) or EnderPay (a block-game look:
 * stone panels, bevelled blocks, a pixel font). Appearance only: switching
 * only sets `data-theme` on <html>, so no page reloads and no React state is
 * touched, and nothing is sent to the server. All colours come from the CSS
 * tokens in styles.css.
 *
 * The choice is not remembered (owner's decision, D-075): every page load
 * opens in Classic, and a choice saved by an older version is removed. It
 * lasts while the app stays open (moving between tabs keeps it).
 *
 * This module is DOM-free (unit-tested under Node); the browser side
 * (<html data-theme>) is in components/ThemeSwitch.tsx.
 */

export const THEMES = ['classic', 'electric', 'enderpay'] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = 'classic';

/** Anything unknown, missing or malformed is the default. Pure. */
export const parseTheme = (value: unknown): Theme =>
  (THEMES as readonly unknown[]).includes(value) ? (value as Theme) : DEFAULT_THEME;

/** Where versions before D-075 saved the choice; only ever removed now. */
export const THEME_STORAGE_KEY = 'threat-intel-agent:theme';

/**
 * Remove a theme saved by an older version, so nothing lingers in the
 * browser. False when there was nothing to remove or storage refuses. Pure
 * (on the storage given).
 */
export function forgetSavedTheme(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null | undefined,
): boolean {
  try {
    if (storage === null || storage === undefined) return false;
    if (storage.getItem(THEME_STORAGE_KEY) === null) return false;
    storage.removeItem(THEME_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

// ── the current theme, shared by every component (no context, no reload) ──

let current: Theme = DEFAULT_THEME;
const listeners = new Set<() => void>();

/** Record the theme and notify subscribers (the DOM side is in ThemeSwitch.tsx). */
export function setTheme(theme: Theme): void {
  current = theme;
  for (const l of listeners) l();
}

export const currentTheme = (): Theme => current;

export function onThemeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
