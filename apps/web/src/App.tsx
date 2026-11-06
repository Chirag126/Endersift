/**
 * The application shell: navigation, the deployment's configuration and the
 * login state, shared with every page.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { ErrorNotice, Loading, Status } from './components/ui.tsx';
import { useApi, useProviderWake, useRoute } from './hooks.tsx';
import { AudioControls, EnderPayAudio } from './components/AudioManager.tsx';
import { useTheme } from './components/ThemeSwitch.tsx';
import { liveNetworksLabel } from './lib/format.ts';
import { STATE_TEXT, agentState, stateTone } from './lib/state.ts';
import type { Health, PublicConfig } from './lib/types.ts';
import { WAKE_TEXT, type WakeState } from './lib/wake.ts';
import { ApprovalsPage } from './pages/Approvals.tsx';
import { EvidencePage } from './pages/Evidence.tsx';
import { HolderPage } from './pages/Holder.tsx';
import { LogsPage } from './pages/Logs.tsx';
import { NewTaskPage } from './pages/NewTask.tsx';
import { OverviewPage } from './pages/Overview.tsx';
import { PaymentsPage } from './pages/Payments.tsx';
import { ProvidersPage } from './pages/Providers.tsx';
import { RulesPage } from './pages/Rules.tsx';
import { SchedulePage } from './pages/Schedule.tsx';
import { TaskPage } from './pages/Task.tsx';
import { UsagePage } from './pages/Usage.tsx';

interface AppState {
  readonly config: PublicConfig;
  readonly authenticated: boolean;
  readonly refreshSession: () => void;
  /** Reload the configuration (after the owner saves the spending rules). */
  readonly refreshConfig: () => void;
  /** The provider host, as this browser sees it while waking it (D-085); 'off' when not set. */
  readonly providerHost: WakeState;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (state === null) throw new Error('useApp outside the app shell');
  return state;
}

interface NavItem {
  readonly path: string;
  readonly label: string;
  readonly match: string;
}
const NAV: readonly (readonly NavItem[])[] = [
  [
    { path: '#/', label: 'Overview', match: '' },
    { path: '#/new', label: 'New task', match: 'new' },
    { path: '#/schedule', label: 'Daily brief', match: 'schedule' },
    { path: '#/evidence', label: 'Runs', match: 'evidence' },
    { path: '#/logs', label: 'Activity log', match: 'logs' },
  ],
  [
    { path: '#/payments', label: 'Payments', match: 'payments' },
    { path: '#/approvals', label: 'Approvals', match: 'approvals' },
    { path: '#/usage', label: '0G usage', match: 'usage' },
    { path: '#/providers', label: 'Providers', match: 'providers' },
    { path: '#/rules', label: 'Spending rules', match: 'rules' },
    // the holder lane (#/holder) stays reachable but is not listed while 0G's Privy app ID is
    // missing (D-089)
  ],
];

function page(route: string[]): ReactNode {
  const [first, second] = route;
  switch (first) {
    case undefined:
      return <OverviewPage />;
    case 'new':
      return <NewTaskPage />;
    case 'tasks':
      return second === undefined ? <OverviewPage /> : <TaskPage taskId={second} key={second} />;
    case 'providers':
      return <ProvidersPage />;
    case 'payments':
      return <PaymentsPage />;
    case 'usage':
      return <UsagePage />;
    case 'rules':
      return <RulesPage />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'evidence':
      return <EvidencePage />;
    case 'logs':
      return <LogsPage />;
    case 'holder':
      return <HolderPage />;
    case 'schedule':
      return <SchedulePage />;
    default:
      return (
        <section>
          <h1>Page not found</h1>
          <p>
            Go to the <a href="#/">overview</a>.
          </p>
        </section>
      );
  }
}

/** Mode, agent state and the payment switch, on every page. */
function StatusBar({ config, providerHost }: { config: PublicConfig; providerHost: WakeState }) {
  const health = useApi<Health>('/api/health', 5_000);
  const state = agentState({
    reachable: health.error === null,
    running: health.data?.queue.running ?? null,
    pending: health.data?.queue.pending ?? 0,
    paymentsPaused: config.policy.paymentsPaused,
    approvalsPending: health.data?.approvals?.pending ?? 0,
  });
  const waiting = health.data?.approvals?.pending ?? 0;
  const human = config.policy.approvalMode === 'human';
  const enderpay = useTheme() === 'enderpay';
  return (
    <div className="statusbar" role="status" aria-live="polite">
      <span className={`mode mode-${config.mode}`}>
        {config.mode === 'live'
          ? liveNetworksLabel(config.networks)
          : 'Mock data, nothing real is spent'}
      </span>
      {health.data === null && health.error === null ? (
        <span className="hint">Checking the agent…</span>
      ) : (
        <Status tone={stateTone(state)}>{STATE_TEXT[state]}</Status>
      )}
      {waiting > 0 ? (
        <a className="statusbar-approval" href="#/approvals">
          {waiting} payment{waiting === 1 ? '' : 's'} waiting for your approval
        </a>
      ) : (
        <span className="hint">{human ? 'Human approval on' : 'Autonomous'}</span>
      )}
      {config.policy.paymentsPaused ? (
        <a className="statusbar-paused" href="#/rules">
          Kill switch on: every payment is refused
        </a>
      ) : (
        <span className="hint">
          Payments allowed,{' '}
          {config.policy.source === 'owner'
            ? `owner rules v${config.policy.version ?? '?'}`
            : 'limits from the server configuration'}
        </span>
      )}
      {providerHost === 'off' ? null : (
        <Status
          tone={providerHost === 'ready' ? 'good' : providerHost === 'waking' ? 'warn' : 'bad'}
        >
          {WAKE_TEXT[providerHost]}
        </Status>
      )}
      {enderpay ? <AudioControls /> : null}
    </div>
  );
}

export function App() {
  const route = useRoute();
  const config = useApi<PublicConfig>('/api/config', 30_000);
  const session = useApi<{ authenticated: boolean }>('/api/session');
  const providerHost = useProviderWake(
    config.data?.mode === 'live' ? (config.data.providerWake?.url ?? null) : null,
  );
  const active = route[0] === 'tasks' ? 'new' : (route[0] ?? '');

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="rail">
        <div className="brand">
          <span className="brand-name">Endersift</span>
          <span className="brand-sub">{config.data?.ensParent ?? 'ENS, Hedera and 0G'}</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((group, i) => (
            <ul key={i}>
              {group.map((n) => (
                <li key={n.path}>
                  <a href={n.path} aria-current={active === n.match ? 'page' : undefined}>
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
          ))}
        </nav>
        {config.data === null ? null : (
          <ul className="networks" aria-label="Networks">
            <li>ENS on Sepolia</li>
            <li>Hedera {config.data.networks.hedera}</li>
            <li>0G {config.data.networks.zg}</li>
          </ul>
        )}
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        {config.error !== null ? (
          <ErrorNotice
            error={config.error}
            action={
              <button type="button" className="button-quiet" onClick={config.reload}>
                Try again
              </button>
            }
          />
        ) : config.data === null ? (
          <Loading what="the agent" />
        ) : (
          <AppContext.Provider
            value={{
              config: config.data,
              authenticated: session.data?.authenticated === true,
              refreshSession: session.reload,
              refreshConfig: config.reload,
              providerHost,
            }}
          >
            <StatusBar config={config.data} providerHost={providerHost} />
            <EnderPayAudio />
            <div className="page">{page(route)}</div>
          </AppContext.Provider>
        )}
      </main>
    </div>
  );
}
