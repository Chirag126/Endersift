// Needs zod + the workspace link to @agent-economy/core (CI and owner's machine).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BalanceSnapshotTrigger,
  FundingSource,
  INFERENCE_TRANSITIONS,
  InferenceStatus,
  InferencePurpose,
  PAYMENT_TRANSITIONS,
  PaymentStatus,
  RUN_TRANSITIONS,
  RunEventType,
  RunStatus,
} from '@agent-economy/core/domain';
import { openDatabase } from '../src/db/database.ts';
import {
  MIGRATIONS,
  SQL_INFERENCE_TRANSITIONS,
  SQL_PAYMENT_TRANSITIONS,
  SQL_RUN_TRANSITIONS,
} from '../src/db/migrations.ts';
import {
  appendRunEvent,
  createRun,
  getReport,
  getRun,
  listProviders,
  listRunEvents,
  saveReport,
  updateRun,
  upsertProvider,
} from '../src/db/repositories.ts';

const NOW = '2026-10-27T00:00:00.000Z';
const LATER = '2026-10-27T00:01:00.000Z';
const RUN_ID = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';

function fresh() {
  const { db } = openDatabase(':memory:');
  createRun(db, {
    id: RUN_ID,
    trigger: 'manual',
    watchlist: ['OpenSSL'],
    status: 'QUEUED',
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
    error: null,
  });
  return db;
}

describe('repositories', () => {
  it('round-trip providers, runs, events and reports through the domain schemas', () => {
    const db = fresh();
    upsertProvider(db, {
      ensName: 'kev.chirag126.eth',
      label: 'kev',
      chain: 'sepolia',
      resolver: '0x1993BB58708a630AF1CC01304Dd851BDEccF9261',
      endpoint: 'https://providers.example/v1/kev',
      capabilities: ['known-exploited-vulns'],
      payTo: '0.0.11044329',
      network: 'hedera:testnet',
      asset: '0.0.0',
      priceAtomic: '100000',
      discoveredAt: NOW,
    });
    assert.equal(listProviders(db)[0]?.capabilities[0], 'known-exploited-vulns');

    const run = getRun(db, RUN_ID);
    assert.ok(run !== null);
    updateRun(db, { ...run, status: 'RUNNING', startedAt: LATER });
    assert.equal(getRun(db, RUN_ID)?.status, 'RUNNING');

    appendRunEvent(db, { runId: RUN_ID, type: 'RUN_STARTED', payload: {}, at: NOW });
    appendRunEvent(db, {
      runId: RUN_ID,
      type: 'PROVIDERS_DISCOVERED',
      payload: { count: 1 },
      at: LATER,
    });
    assert.deepEqual(
      listRunEvents(db, RUN_ID).map((e) => e.seq),
      [0, 1],
    );

    saveReport(db, { runId: RUN_ID, markdown: '# Brief', createdAt: LATER });
    assert.equal(getReport(db, RUN_ID)?.markdown, '# Brief');
  });

  it('refuses invalid input before it reaches SQL', () => {
    const db = fresh();
    assert.throws(() => upsertProvider(db, { ensName: 'NOT VALID' } as never));
  });
});

describe('schema ↔ domain consistency', () => {
  const sql = MIGRATIONS.map((m) => m.sql).join('\n');
  /** The latest CHECK list for a column (later migrations supersede earlier ones). */
  const checkList = (column: string): string[] => {
    const all = [
      ...sql.matchAll(
        new RegExp(`${column}\\s+TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)\\)`, 'g'),
      ),
    ];
    const m = all.at(-1);
    assert.ok(m?.[1] !== undefined, `no CHECK list for ${column}`);
    return m[1]
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
      .sort();
  };

  it('SQL enum CHECKs equal the zod enums', () => {
    assert.deepEqual(checkList('purpose'), [...InferencePurpose.options].sort());
    assert.deepEqual(checkList('funding'), [...FundingSource.options].sort());
    assert.deepEqual(checkList('type'), [...RunEventType.options].sort());
    // status appears in several tables; compare via the shared constants instead
    assert.ok(sql.includes(RunStatus.options.map((s) => `'${s}'`).join(',')));
    assert.ok(sql.includes(PaymentStatus.options.map((s) => `'${s}'`).join(',')));
    assert.ok(sql.includes(InferenceStatus.options.map((s) => `'${s}'`).join(',')));
    assert.deepEqual(checkList('trigger'), [...BalanceSnapshotTrigger.options].sort());
  });

  it('SQL inference transitions equal the domain state machine', () => {
    const domain = Object.entries(INFERENCE_TRANSITIONS)
      .flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`))
      .sort();
    const db = SQL_INFERENCE_TRANSITIONS.map(([f, t]) => `${f}>${t}`).sort();
    assert.deepEqual(db, domain);
  });

  it('SQL run transitions equal the domain', () => {
    const domain = Object.entries(RUN_TRANSITIONS)
      .flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`))
      .sort();
    assert.deepEqual(SQL_RUN_TRANSITIONS.map(([f, t]) => `${f}>${t}`).sort(), domain);
  });

  it('SQL payment transitions equal the domain state machine', () => {
    const domain = Object.entries(PAYMENT_TRANSITIONS)
      .flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`))
      .sort();
    const db = SQL_PAYMENT_TRANSITIONS.map(([f, t]) => `${f}>${t}`).sort();
    assert.deepEqual(db, domain);
  });
});
