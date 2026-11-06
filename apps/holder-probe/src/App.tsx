import { usePrivy } from '@privy-io/react-auth';
import { useState } from 'react';
import {
  HOLDER_CREDIT_RUNS,
  buildEvidence,
  decodeJwtClaims,
  laneResult,
  type LaneResult,
  interpretBalance,
  interpretKeyList,
  type AppIdKind,
  type RouterCall,
  type ZgNetwork,
} from './probe.ts';

async function routerGet(network: ZgNetwork, path: string, token: string): Promise<RouterCall> {
  try {
    // Same-origin path, proxied read-only by vite.config.ts. The token stays in memory.
    const res = await fetch(`/zg/${network}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (error) {
    return {
      status: null,
      body: null,
      networkError: error instanceof Error ? error.message : String(error),
    };
  }
}

export function App({ configuredAppId }: { configuredAppId: string }) {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const [network, setNetwork] = useState<ZgNetwork>('mainnet');
  const [kind, setKind] = useState<AppIdKind>('0g');
  const [evidence, setEvidence] = useState<string | null>(null);
  const [result, setResult] = useState<LaneResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wallets = (user?.linkedAccounts ?? [])
    .filter((a) => a.type === 'wallet')
    .map((a) => ('address' in a && typeof a.address === 'string' ? a.address : ''))
    .filter((a) => a !== '');

  async function runProbe() {
    setRunning(true);
    setError(null);
    setEvidence(null);
    setResult(null);
    try {
      const token = await getAccessToken();
      if (token === null) throw new Error('Privy returned no access token; log in again.');
      const balanceCall = await routerGet(network, '/account/balance', token);
      const keysCall = await routerGet(network, '/api-keys', token);
      const { step: balanceStep, balance } = interpretBalance(balanceCall);
      const { step: keysStep, keyCount } = interpretKeyList(keysCall);
      setResult(laneResult(balance, balanceStep, keysStep));
      setEvidence(
        buildEvidence({
          network,
          appIdKind: kind,
          origin: window.location.origin,
          privyUserLinked: true,
          walletAddresses: wallets,
          claims: decodeJwtClaims(token),
          configuredAppId,
          balanceStep,
          balance,
          keysStep,
          keyCount,
          now: new Date(),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function download() {
    if (evidence === null) return;
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    const url = URL.createObjectURL(new Blob([evidence], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `holder-probe-${network}-${kind}-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main
      style={{
        fontFamily: 'system-ui',
        maxWidth: 760,
        margin: '2rem auto',
        padding: '0 16px',
        lineHeight: 1.5,
      }}
    >
      <h1>Holder lane</h1>
      <p>
        Sign in with Privy to see your 0G balance. This page only reads: it spends, creates and
        stores nothing, and your access token never leaves this tab except to the local read-only
        proxy.
      </p>
      <p>
        <strong>Running tasks on your 0G credits:</strong> {HOLDER_CREDIT_RUNS.reason}
      </p>
      <p>
        Origin: <code>{window.location.origin}</code>
      </p>

      {!ready ? (
        <p>Loading Privy…</p>
      ) : !authenticated ? (
        <button onClick={login}>Log in with Privy</button>
      ) : (
        <>
          <p>
            Logged in. Wallets:{' '}
            {wallets.length === 0 ? '(none linked)' : wallets.map((w) => <code key={w}>{w} </code>)}
          </p>
          <fieldset style={{ marginBottom: 12 }}>
            <legend>Probe settings</legend>
            <label>
              Network{' '}
              <select value={network} onChange={(e) => setNetwork(e.target.value as ZgNetwork)}>
                <option value="mainnet">mainnet (pc.0g.ai)</option>
                <option value="testnet">testnet (pc.testnet.0g.ai)</option>
              </select>
            </label>{' '}
            <label>
              App ID is{' '}
              <select value={kind} onChange={(e) => setKind(e.target.value as AppIdKind)}>
                <option value="0g">0G&apos;s Privy app ID (real test)</option>
                <option value="own">my own Privy app ID (negative control)</option>
              </select>
            </label>
          </fieldset>
          <button onClick={runProbe} disabled={running}>
            {running ? 'Probing…' : 'Run read-only probe'}
          </button>{' '}
          <button onClick={logout}>Log out</button>
        </>
      )}

      {error !== null && <p style={{ color: 'crimson' }}>Error: {error}</p>}
      {result !== null && (
        <section aria-label="Your 0G account" style={{ border: '1px solid #ccd', padding: 12 }}>
          <h2>Your 0G account ({network})</h2>
          <p>
            <strong>Balance:</strong> {result.balanceText}
          </p>
          <p>{result.accessText}</p>
        </section>
      )}
      {evidence !== null && (
        <section>
          <h2>Evidence</h2>
          <button onClick={download}>Download evidence JSON</button>
          <pre style={{ background: '#f4f4f4', padding: 12, overflowX: 'auto' }}>{evidence}</pre>
        </section>
      )}
    </main>
  );
}
