// Runs without workspace links: node:sqlite + raw SQL only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MigrationError, migrate, openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

const NOW = '2026-10-27T00:00:00.000Z';
const RUN = 'r1';

function seedRun(db: ReturnType<typeof openDatabase>['db']) {
  db.prepare(
    `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES (?, 'manual', '["x"]', 'QUEUED', ?)`,
  ).run(RUN, NOW);
}

function insertPayment(
  db: ReturnType<typeof openDatabase>['db'],
  id: string,
  status = 'CREATED',
  tx: string | null = null,
) {
  db.prepare(
    `INSERT INTO payment_intents (id, run_id, provider, pay_to, network, asset, amount_atomic, status, transaction_id, created_at, updated_at,
       idempotency_key, capability, request_url)
     VALUES (?, ?, 'kev.chirag126.eth', '0.0.11044329', 'hedera:testnet', '0.0.0', '100000', ?, ?, ?, ?, ?, 'known-exploited-vulns', 'http://127.0.0.1:4021/v1/kev/recent')`,
  ).run(id, RUN, status, tx, NOW, NOW, `key-${id}`);
}

const setStatus = (
  db: ReturnType<typeof openDatabase>['db'],
  id: string,
  status: string,
  tx?: string,
) =>
  tx === undefined
    ? db.prepare('UPDATE payment_intents SET status = ? WHERE id = ?').run(status, id)
    : db
        .prepare('UPDATE payment_intents SET status = ?, transaction_id = ? WHERE id = ?')
        .run(status, tx, id);

describe('migrations', () => {
  it('apply once, record checksums, and are idempotent on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'db-'));
    try {
      const path = join(dir, 'nested', 'test.db');
      const first = openDatabase(path);
      assert.deepEqual(first.migration.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(first.migration.current, 10);
      first.db.close();
      const second = openDatabase(path);
      assert.deepEqual(second.migration.applied, []);
      assert.equal(second.migration.current, 10);
      const tables = (
        second.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((t) => t.name);
      for (const t of [
        'hcs_messages',
        'inference_calls',
        'payment_approvals',
        'payment_intents',
        'payment_transitions',
        'policy_versions',
        'providers',
        'reports',
        'run_events',
        'runs',
        'schedule_runs',
        'schedules',
        'schema_migrations',
        'settlement_verifications',
        'zg_balance_snapshots',
      ]) {
        assert.ok(tables.includes(t), t);
      }
      assert.equal(
        (second.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'wal',
      );
      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an edited migration and a database newer than the code', () => {
    const { db } = openDatabase(':memory:');
    const edited = [{ ...MIGRATIONS[0]!, sql: `${MIGRATIONS[0]!.sql}\n-- edited` }];
    assert.throws(() => migrate(db, edited), MigrationError);
    assert.throws(() => migrate(db, []), /does not know/);
    db.close();
  });

  it('rolls back a failing migration', () => {
    const { db } = openDatabase(':memory:');
    const bad = [
      ...MIGRATIONS,
      {
        id: MIGRATIONS.length + 1,
        name: 'broken',
        sql: 'CREATE TABLE ok_table (x TEXT) STRICT; SELECT * FROM missing_table;',
      },
    ];
    assert.throws(() => migrate(db, bad), new RegExp(`migration ${MIGRATIONS.length + 1} failed`));
    const exists = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ok_table'")
      .get() as { n: number };
    assert.equal(Number(exists.n), 0);
    db.close();
  });
});

describe('schema guards (database level)', () => {
  it('enforces foreign keys and enum checks', () => {
    const { db } = openDatabase(':memory:');
    assert.throws(() => insertPayment(db, 'p0'), /FOREIGN KEY/);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES ('r', 'manual', '[]', 'DONE', ?)`,
          )
          .run(NOW),
      /CHECK/,
    );
    db.close();
  });

  it('only creates payments in CREATED and walks the allowed path', () => {
    const { db } = openDatabase(':memory:');
    seedRun(db);
    assert.throws(
      () => insertPayment(db, 'p1', 'SETTLED', '0.0.1@1.000000001'),
      /created in status CREATED/,
    );
    insertPayment(db, 'p1');
    setStatus(db, 'p1', 'AUTHORIZED');
    setStatus(db, 'p1', 'SIGNED', '0.0.7162784@1792969955.376969750');
    setStatus(db, 'p1', 'SUBMITTED');
    setStatus(db, 'p1', 'UNKNOWN');
    // The rule that matters: an UNKNOWN payment can never be re-signed.
    assert.throws(() => setStatus(db, 'p1', 'SIGNED'), /illegal payment status transition/);
    assert.throws(
      () => setStatus(db, 'p1', 'SETTLED'),
      /needs settled_at|SETTLED only after a Mirror Node verification/,
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE payment_intents SET status = 'SETTLED', settled_at = ? WHERE id = 'p1'")
          .run(NOW),
      /SETTLED only after a Mirror Node verification/,
    );
    db.prepare(
      `INSERT INTO settlement_verifications (id, payment_id, transaction_id, mirror_node, outcome, consensus_timestamp, checks, entries, verified_at)
       VALUES ('v1', 'p1', '0.0.7162784@1792969955.376969750', 'https://mirror.test', 'SETTLED', '1792969960.1', '[]', 1, ?)`,
    ).run(NOW);
    db.prepare("UPDATE payment_intents SET status = 'SETTLED', settled_at = ? WHERE id = 'p1'").run(
      NOW,
    );
    assert.throws(() => setStatus(db, 'p1', 'FAILED'), /illegal payment status transition/);
    db.close();
  });

  it('keeps a recorded transaction ID immutable and requires one once signed', () => {
    const { db } = openDatabase(':memory:');
    seedRun(db);
    insertPayment(db, 'p2');
    setStatus(db, 'p2', 'AUTHORIZED');
    assert.throws(() => setStatus(db, 'p2', 'SIGNED'), /CHECK/);
    setStatus(db, 'p2', 'SIGNED', '0.0.7162784@1792969955.376969750');
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE payment_intents SET transaction_id = '0.0.1@1.000000001' WHERE id = 'p2'",
          )
          .run(),
      /cannot change/,
    );
    db.close();
  });

  it('refuses a credit-funded inference row without credit_used > 0', () => {
    const { db } = openDatabase(':memory:');
    const insert = (funding: string, credit: string | null) =>
      db
        .prepare(
          `INSERT INTO inference_calls (id, purpose, network, model, status, funding, credit_used_neuron, created_at)
           VALUES (?, 'PROBE', 'testnet', 'm', 'REFUSED', ?, ?, ?)`,
        )
        .run(`${funding}-${credit}`, funding, credit, NOW);
    assert.throws(() => insert('credits', '0'), /CHECK/);
    assert.throws(() => insert('credits', null), /CHECK/);
    insert('credits', '5');
    insert('deposit', '0');
    db.close();
  });

  it('upgrades a migration-1 database without losing inference rows', () => {
    const { db } = openDatabase(':memory:', MIGRATIONS.slice(0, 1));
    db.prepare(
      `INSERT INTO inference_calls (id, purpose, network, model, status, request_id, cost_neuron, funding, created_at)
       VALUES ('old', 'PROBE', 'testnet', 'm', 'SUCCEEDED', 'req-1', '599355333333333', 'deposit', ?)`,
    ).run(NOW);
    assert.deepEqual(migrate(db).applied, [2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const row = db.prepare("SELECT * FROM inference_calls WHERE id = 'old'").get() as Record<
      string,
      unknown
    >;
    assert.equal(row['status'], 'SUCCEEDED');
    assert.equal(row['cost_neuron'], '599355333333333');
    assert.equal(row['settled_at'], NOW);
    assert.equal(row['worst_case_neuron'], null);
    db.close();
  });

  it('migration 10 keeps inference rows and guards, allows TRANSCRIBE, joins a run once (D-076)', () => {
    const { db } = openDatabase(':memory:', MIGRATIONS.slice(0, 9));
    db.prepare(
      `INSERT INTO inference_calls (id, purpose, network, model, status, worst_case_neuron, funding, created_at)
       VALUES ('p1', 'PLAN', 'testnet', 'm', 'PENDING', '5', 'unknown', ?)`,
    ).run(NOW);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO inference_calls (id, purpose, network, model, status, funding, created_at)
             VALUES ('t0', 'TRANSCRIBE', 'testnet', 'm', 'REFUSED', 'none', ?)`,
          )
          .run(NOW),
      /CHECK/,
    );
    assert.deepEqual(migrate(db).applied, [10]);
    const kept = db.prepare("SELECT * FROM inference_calls WHERE id = 'p1'").get() as Record<
      string,
      unknown
    >;
    assert.equal(kept['worst_case_neuron'], '5');
    assert.equal(kept['status'], 'PENDING');
    // the old guards are back
    assert.throws(
      () => db.prepare("UPDATE inference_calls SET status = 'REFUSED' WHERE id = 'p1'").run(),
      /illegal inference status transition/,
    );
    assert.throws(
      () => db.prepare("UPDATE inference_calls SET worst_case_neuron = '6' WHERE id = 'p1'").run(),
      /cannot change/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO inference_calls (id, purpose, network, model, status, funding, created_at)
             VALUES ('x', 'PLAN', 'testnet', 'm', 'SUCCEEDED', 'none', ?)`,
          )
          .run(NOW),
      /created PENDING/,
    );
    // a voice transcription, recorded before its task, joins one run once
    db.prepare(
      `INSERT INTO inference_calls (id, purpose, network, model, status, worst_case_neuron, funding, created_at)
       VALUES ('t1', 'TRANSCRIBE', 'testnet', 'w', 'PENDING', '5', 'unknown', ?)`,
    ).run(NOW);
    const run = (id: string) =>
      db
        .prepare(
          `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES (?, 'manual', '["x"]', 'RUNNING', ?)`,
        )
        .run(id, NOW);
    const r1 = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
    const r2 = '1b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
    run(r1);
    run(r2);
    db.prepare("UPDATE inference_calls SET run_id = ? WHERE id = 't1'").run(r1);
    assert.throws(
      () => db.prepare("UPDATE inference_calls SET run_id = ? WHERE id = 't1'").run(r2),
      /joins a run, and only once/,
    );
    assert.throws(
      () => db.prepare("UPDATE inference_calls SET run_id = ? WHERE id = 'p1'").run(r2),
      /joins a run, and only once/,
    );
    db.close();
  });

  it('migration 5 keeps existing run events and then guards runs and their timeline', () => {
    const { db } = openDatabase(':memory:', MIGRATIONS.slice(0, 4));
    const run = '0b9f6f0e-5d0a-4c6b-9a43-1f2e3d4c5b6a';
    db.prepare(
      `INSERT INTO runs (id, trigger, watchlist, status, created_at) VALUES (?, 'manual', '["x"]', 'RUNNING', ?)`,
    ).run(run, NOW);
    db.prepare(
      `INSERT INTO run_events (run_id, seq, type, payload, at) VALUES (?, 0, 'RUN_STARTED', '{"a":1}', ?)`,
    ).run(run, NOW);
    assert.deepEqual(migrate(db, MIGRATIONS.slice(0, 5)).applied, [5]);
    const kept = db.prepare('SELECT payload FROM run_events WHERE run_id = ?').get(run) as {
      payload: string;
    };
    assert.equal(kept.payload, '{"a":1}');
    const event = (seq: number, type: string, payload = '{}') =>
      db
        .prepare('INSERT INTO run_events (run_id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?)')
        .run(run, seq, type, payload, NOW);
    assert.throws(() => event(2, 'CATALOG_READ'), /without gaps/);
    assert.throws(() => event(0, 'CATALOG_READ'), /without gaps/);
    assert.throws(() => event(1, 'NOT_A_TYPE'), /CHECK/);
    assert.throws(() => event(1, 'CATALOG_READ', '[1]'), /CHECK/);
    event(1, 'CATALOG_READ');
    assert.throws(
      () => db.prepare(`UPDATE runs SET watchlist = '["y"]' WHERE id = ?`).run(run),
      /cannot change/,
    );
    db.prepare("UPDATE runs SET status = 'SUCCEEDED' WHERE id = ?").run(run);
    assert.throws(() => event(2, 'RUN_FINISHED'), /finished run/);
    assert.throws(
      () => db.prepare("UPDATE runs SET status = 'FAILED' WHERE id = ?").run(run),
      /illegal run status transition/,
    );
    db.close();
  });

  it('guards the inference lifecycle: born PENDING or REFUSED, forward only, billing immutable', () => {
    const { db } = openDatabase(':memory:');
    const insert = (id: string, status: string, worst: string | null) =>
      db
        .prepare(
          `INSERT INTO inference_calls (id, purpose, network, model, status, worst_case_neuron, funding, created_at)
           VALUES (?, 'ANALYZE', 'testnet', 'm', ?, ?, 'unknown', ?)`,
        )
        .run(id, status, worst, NOW);
    assert.throws(() => insert('a', 'SUCCEEDED', '10'), /created PENDING \(reserved\) or REFUSED/);
    assert.throws(() => insert('a', 'PENDING', null), /CHECK/);
    insert('a', 'PENDING', '10');
    const update = (sql: string) => db.prepare(sql).run();
    // SUCCEEDED needs the request ID and cost
    assert.throws(
      () => update("UPDATE inference_calls SET status = 'SUCCEEDED' WHERE id = 'a'"),
      /CHECK/,
    );
    update("UPDATE inference_calls SET status = 'UNKNOWN' WHERE id = 'a'");
    assert.throws(
      () => update("UPDATE inference_calls SET status = 'PENDING' WHERE id = 'a'"),
      /illegal inference status transition/,
    );
    update(
      "UPDATE inference_calls SET status = 'SUCCEEDED', request_id = 'r', cost_neuron = '7' WHERE id = 'a'",
    );
    assert.throws(
      () => update("UPDATE inference_calls SET status = 'FAILED' WHERE id = 'a'"),
      /illegal inference status transition/,
    );
    for (const sql of [
      "UPDATE inference_calls SET cost_neuron = '1' WHERE id = 'a'",
      "UPDATE inference_calls SET request_id = 'other' WHERE id = 'a'",
      "UPDATE inference_calls SET worst_case_neuron = '99' WHERE id = 'a'",
    ])
      assert.throws(() => update(sql), /cannot change/, sql);
    db.close();
  });

  it('requires a purchase identity, keeps it unique and immutable', () => {
    const { db } = openDatabase(':memory:');
    seedRun(db);
    insertPayment(db, 'p3');
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO payment_intents (id, run_id, provider, pay_to, network, asset, amount_atomic, status, created_at, updated_at)
             VALUES ('p4', ?, 'kev.chirag126.eth', '0.0.11044329', 'hedera:testnet', '0.0.0', '100000', 'CREATED', ?, ?)`,
          )
          .run(RUN, NOW, NOW),
      /need an idempotency key/,
    );
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO payment_intents (id, run_id, provider, pay_to, network, asset, amount_atomic, status, created_at, updated_at,
               idempotency_key, capability, request_url)
             VALUES ('p5', ?, 'kev.chirag126.eth', '0.0.11044329', 'hedera:testnet', '0.0.0', '100000', 'CREATED', ?, ?, 'key-p3', 'c', 'u')`,
          )
          .run(RUN, NOW, NOW),
      /UNIQUE/,
    );
    for (const sql of [
      "UPDATE payment_intents SET amount_atomic = '1' WHERE id = 'p3'",
      "UPDATE payment_intents SET pay_to = '0.0.666' WHERE id = 'p3'",
      "UPDATE payment_intents SET idempotency_key = 'other' WHERE id = 'p3'",
    ])
      assert.throws(() => db.prepare(sql).run(), /cannot change/, sql);
    db.close();
  });
});
