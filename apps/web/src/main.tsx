import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme, browserStorage } from './components/ThemeSwitch.tsx';
import { DEFAULT_THEME, forgetSavedTheme } from './lib/theme.ts';
import './styles.css';
import './enderpay.css';

// every page load opens in Classic (D-075); a choice saved by an older version is removed
forgetSavedTheme(browserStorage());
applyTheme(DEFAULT_THEME);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
