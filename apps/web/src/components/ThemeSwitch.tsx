/**
 * Classic / Electric / EnderPay switch (Phase UI toggle) and the browser side of the
 * theme: `data-theme` on <html>. Appearance only, for this page load: every
 * load opens in Classic (D-075). The rules (DOM-free, unit-tested) are in
 * lib/theme.ts.
 */
import { useSyncExternalStore } from 'react';
import { THEMES, currentTheme, onThemeChange, setTheme, type Theme } from '../lib/theme.ts';

/** localStorage (used by the EnderPay sound settings), or null where touching it throws. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Set `data-theme` on <html>. `animate` adds a short colour transition (skipped for reduced motion). */
export function applyTheme(theme: Theme, animate = false): void {
  const root = document.documentElement;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (animate && !reduced) {
    root.classList.add('theme-switching');
    window.setTimeout(() => root.classList.remove('theme-switching'), 320);
  }
  root.dataset['theme'] = theme;
  setTheme(theme);
}

/** Subscribe for React. */
export function subscribeTheme(listener: () => void): () => void {
  return onThemeChange(listener);
}

/** Switch for this page load; nothing is saved (D-075). */
export function chooseTheme(theme: Theme): void {
  applyTheme(theme, true);
}

const LABEL: Readonly<Record<Theme, string>> = {
  classic: 'Classic',
  electric: 'Electric',
  enderpay: 'EnderPay',
};

export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, currentTheme, currentTheme);
}

export function ThemeSwitch() {
  const theme = useTheme();
  return (
    <div className="theme-switch" role="group" aria-label="Interface theme">
      <span className="theme-switch-label" aria-hidden="true">
        Theme
      </span>
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          className={`theme-option${theme === t ? ' theme-option-on' : ''}`}
          aria-pressed={theme === t}
          onClick={() => {
            if (theme !== t) chooseTheme(t);
          }}
        >
          <span className={`theme-swatch theme-swatch-${t}`} aria-hidden="true" />
          {LABEL[t]}
        </button>
      ))}
    </div>
  );
}
