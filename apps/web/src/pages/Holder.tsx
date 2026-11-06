/**
 * The holder lane (plan rows 6 and 30, D-026, D-058): a 0G holder signs in with
 * Privy on localhost and sees their 0G balance. Running tasks on a holder's
 * credits is not built, because the probe has not shown it is possible. This
 * page states the status; the lane itself is a separate localhost app, since
 * 0G's Privy app ID works only on localhost:3000, 3001 and 5173. Not in the
 * navigation while the bonus is blocked (D-089); the route stays.
 */
import { Notice, PageHead, Status } from '../components/ui.tsx';
import { isLocalhost } from '../lib/deployment.ts';

export function HolderPage() {
  return (
    <>
      <PageHead
        title="Holder lane"
        intro="For 0G holders: sign in with Privy and see your 0G balance, on your own computer. Nothing is spent; the page only reads."
      />
      {isLocalhost(window.location.hostname) ? null : (
        <Notice tone="info">
          The holder lane runs only on localhost: 0G&rsquo;s Privy app ID accepts sign-ins from{' '}
          <code>localhost:3000</code>, <code>3001</code> and <code>5173</code> only. It is not part
          of this hosted deployment; clone the repository and run <code>pnpm holder:lane</code>.
        </Notice>
      )}
      <section aria-labelledby="lane-status">
        <h2 id="lane-status">Where it stands</h2>
        <ul className="layers">
          <li>
            <Status tone="good">Built</Status>
            <span>
              Privy sign-in and the 0G balance, on localhost: run <code>pnpm holder:lane</code> and
              open <code>http://localhost:3000</code>. It needs <code>VITE_PRIVY_APP_ID</code> in{' '}
              <code>.env</code>.
            </span>
          </li>
          <li>
            <Status tone="neutral">Run</Status>
            <span>
              Negative control with a Privy app that is not 0G’s: the 0G Router refused it
              (2026-10-28).
            </span>
          </li>
          <li>
            <Status tone="neutral">Blocked</Status>
            <span>
              The real test, with 0G’s Privy app ID: does a holder’s sign-in reach their 0G account?
              0G shares its app ID with teams on request; it has not been shared with this project
              yet.
            </span>
          </li>
          <li>
            <Status tone="neutral">Not available</Status>
            <span>
              Running tasks on a holder’s 0G credits. The probe has not shown that a Privy sign-in
              can spend them, and 0G documents no way for an app to do it, so the agent pays for 0G
              with its own key.
            </span>
          </li>
        </ul>
      </section>

      <section aria-labelledby="lane-why">
        <h2 id="lane-why">Why it runs on localhost</h2>
        <p className="page-intro">
          0G’s Privy app ID accepts only <code>localhost:3000</code>, <code>3001</code> and{' '}
          <code>5173</code>. The holder lane takes 3000, beside the agent API on 3001 and this app
          on 5173. A deployed site cannot use it.
        </p>
      </section>
    </>
  );
}
