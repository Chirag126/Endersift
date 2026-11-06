// MOCK API for the web app's smoke test and for trying the UI without
// spending anything. The real API server (createApi, TaskRunner) in front of
// the MOCK orchestrator harness: fake ENS, providers, signer, Mirror Node and
// 0G. Never live verification.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createApi } from '../../src/api/server.ts';
import { TaskRunner } from '../../src/api/task-runner.ts';
import { Scheduler } from '../../src/schedule/scheduler.ts';
import {
  BUY_KEV,
  BUY_OSV,
  PUBLIC_CONFIG,
  analysisJson,
  harness,
  planJson,
} from './orchestrator-harness.ts';

// Public by design: it unlocks only the MOCK API (nothing real is spent) and is printed in the docs.
export const MOCK_ACCESS_CODE = 'mock-access-code'; // secret-scan: allow

export interface MockApi {
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

export async function startMockApi(
  port = 0,
  host = '127.0.0.1',
  options: { readonly webRoot?: string } = {},
): Promise<MockApi> {
  const h = harness({
    plan: () => planJson([BUY_KEV, BUY_OSV]),
    analysis: () =>
      analysisJson(
        ['CVE-2026-1001', 'GHSA-aaaa-bbbb-cccc'],
        'Patch OpenSSL today (mock analysis).',
      ),
    // Human approval (D-066) is answered in the browser, in real time
    approvalRealWait: true,
    approvalTimeoutSec: 600,
  });
  const runner = new TaskRunner(h.orchestrator);
  // the scheduler on the real clock: a schedule created here runs at once when its time has passed
  const scheduler = new Scheduler({
    db: h.db,
    store: h.scheduleStore,
    submit: (request, budget, beforeStart) =>
      runner.submit(request, budget, { origin: 'scheduler', beforeStart }),
  });
  const api = createApi({
    db: h.db,
    runner,
    payments: h.store,
    inference: h.ledger,
    accessCode: MOCK_ACCESS_CODE,
    hashscan: (tx) => `https://hashscan.io/testnet/transaction/${encodeURIComponent(tx)}`,
    migration: 10,
    approvals: h.approvalStore,
    evidenceRoot: resolve('docs/evidence'),
    corsOrigin: null,
    trustProxyHops: 0,
    secureCookies: false,
    publicConfig: PUBLIC_CONFIG,
    policy: h.policyStore,
    mode: 'mock',
    schedules: h.scheduleStore,
    scheduler,
    // the voice task (D-076): a fake speech model behind the real client and ledger
    voice: h.voice,
    // a browser test makes many requests from one address
    limits: { requestsPerMinute: 100_000, tasksPerHour: 1_000 },
    // the built web app on the same origin, as deployed (D-062)
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
  });
  scheduler.start(5_000);
  const server = createServer((req, res) => void api.handler(req, res));
  await new Promise<void>((r) => server.listen(port, host, r));
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  return {
    url,
    server,
    close: async () => {
      scheduler.stop();
      api.closeStreams();
      await runner.idle();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
    },
  };
}
