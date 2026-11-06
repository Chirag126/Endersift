import { PrivyProvider } from '@privy-io/react-auth';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

const appId = import.meta.env['VITE_PRIVY_APP_ID'] as string | undefined;
const root = createRoot(document.getElementById('root') as HTMLElement);

root.render(
  <StrictMode>
    {appId === undefined || appId.trim() === '' ? (
      <main
        style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '2rem auto', padding: '0 16px' }}
      >
        <h1>Holder lane</h1>
        <p>
          <strong>Blocked:</strong> <code>VITE_PRIVY_APP_ID</code> is not set in the repo-root{' '}
          <code>.env</code>.
        </p>
        <p>
          0G shares its Privy app ID with hackathon teams; it is not public. For the negative
          control, use your own free Privy app ID (dashboard.privy.io) with{' '}
          <code>http://localhost:3000</code> as an allowed origin.
        </p>
      </main>
    ) : (
      <PrivyProvider appId={appId.trim()} config={{ loginMethods: ['email', 'google', 'wallet'] }}>
        <App configuredAppId={appId.trim()} />
      </PrivyProvider>
    )}
  </StrictMode>,
);
