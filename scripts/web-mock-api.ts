/**
 * MOCK agent API on SERVER_PORT (default 3001) for trying the web app without
 * spending anything: fake ENS, providers, signer, Mirror Node and 0G behind
 * the real API server. Transaction and request IDs it shows are fake.
 *
 *   pnpm web:mock-api                  (terminal 1)
 *   pnpm web:dev                       (terminal 2) → http://localhost:5173
 *
 * The access code is `mock-access-code`. For the real agent, use pnpm api:start.
 */
import { loadServerConfig } from '../apps/server/src/config.ts';
import { startMockApi, MOCK_ACCESS_CODE } from '../apps/server/test/support/mock-api.ts';
import { handleScriptErrors, loadLocalEnvSource } from './lib/cli.ts';

handleScriptErrors();
const port = loadServerConfig(loadLocalEnvSource()).port;
const api = await startMockApi(port);
console.log(`MOCK agent API on ${api.url} (fake ENS, payments and 0G; nothing is spent)`);
console.log(`  access code: ${MOCK_ACCESS_CODE}`);
console.log('  open the web app with pnpm web:dev → http://localhost:5173');
process.on('SIGINT', () => void api.close().then(() => process.exit(0)));
