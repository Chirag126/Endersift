/**
 * Router balance snapshots into the ledger database (plan row 18).
 *
 *   pnpm ledger:snapshot                one snapshot now (trigger "manual")
 *   pnpm ledger:snapshot -- --every     the job: every ZG_SNAPSHOT_INTERVAL_MIN minutes until Ctrl+C
 *   pnpm ledger:snapshot -- --every 10  every 10 minutes (5-1440)
 *
 * Needs ZG_MANAGEMENT_KEY. Snapshots show the Router float and the pending
 * charge (D-039); they never allow or refuse a call (the caps do).
 */
import {
  startBalanceSnapshotJob,
  takeBalanceSnapshot,
} from '../../apps/server/src/ledger/balance-job.ts';
import { UsageError, argValue, handleScriptErrors, hasFlag } from '../lib/cli.ts';
import { ledgerSetup, snapshotLine } from './shared.ts';

handleScriptErrors();

const s = ledgerSetup({ needManagementKey: true });
const deps = { client: s.client, ledger: s.ledger, network: s.network };

if (!hasFlag('--every')) {
  const shot = await takeBalanceSnapshot(deps, 'manual');
  console.log(`snapshot stored in ${s.databasePath}`);
  console.log(`  ${snapshotLine(shot)}`);
  s.db.close();
} else {
  const arg = argValue('--every');
  const minutes = arg === undefined || arg.startsWith('--') ? s.snapshotIntervalMin : Number(arg);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)
    throw new UsageError('--every takes whole minutes between 5 and 1440');
  console.log(`balance snapshot job: every ${minutes} min into ${s.databasePath} (Ctrl+C to stop)`);
  const job = startBalanceSnapshotJob({
    ...deps,
    intervalMs: minutes * 60_000,
    onSnapshot: (shot) => console.log(`  ${snapshotLine(shot)}`),
    onError: (error) =>
      console.log(
        `  snapshot failed (will retry next tick): ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  process.on('SIGINT', () => {
    void job.stop().then(() => {
      s.db.close();
      console.log('stopped.');
      process.exit(0);
    });
  });
}
