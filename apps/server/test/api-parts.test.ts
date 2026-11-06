// Class: unit. API building blocks: rate limiter windows, connection caps,
// access-code comparison, sessions and cookies, client address behind a
// proxy, and the one-at-a-time task runner.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Run } from '@agent-economy/core/domain';
import { SessionStore, bearer, codeMatches, parseCookies, sessionCookie } from '../src/api/auth.ts';
import { ConnectionCounter, FixedWindowLimiter } from '../src/api/limits.ts';
import { clientAddress, toJson } from '../src/api/server.ts';
import { QueueFullError, TaskRunner, type RunExecutor } from '../src/api/task-runner.ts';

describe('FixedWindowLimiter', () => {
  it('allows `limit` hits per window per key, then reports Retry-After until the window resets', () => {
    let t = 0;
    const l = new FixedWindowLimiter(2, 60_000, () => t);
    assert.ok(l.take('a').allowed);
    assert.ok(l.take('a').allowed);
    const denied = l.take('a');
    assert.ok(!denied.allowed);
    assert.equal(denied.retryAfterSec, 60);
    assert.ok(l.take('b').allowed, 'keys are independent');
    t = 30_000;
    assert.equal(l.take('a').retryAfterSec, 30);
    assert.ok(!l.peek('a').allowed);
    t = 60_000;
    assert.ok(l.take('a').allowed, 'a new window');
  });

  it('peek does not count', () => {
    const l = new FixedWindowLimiter(1, 1000, () => 0);
    assert.ok(l.peek('a').allowed);
    assert.ok(l.peek('a').allowed);
    assert.ok(l.take('a').allowed);
    assert.ok(!l.peek('a').allowed);
  });
});

describe('ConnectionCounter', () => {
  it('caps per key and in total; release is idempotent', () => {
    const c = new ConnectionCounter(1, 2);
    const a = c.acquire('a');
    assert.ok(a !== null);
    assert.equal(c.acquire('a'), null);
    const b = c.acquire('b');
    assert.ok(b !== null);
    assert.equal(c.acquire('c'), null, 'total cap');
    a();
    a();
    assert.equal(c.open, 1);
    assert.ok(c.acquire('c') !== null);
  });
});

describe('access code and sessions', () => {
  it('compares codes exactly, whatever their length', () => {
    assert.ok(codeMatches('correct-horse', 'correct-horse'));
    assert.ok(!codeMatches('correct-hors', 'correct-horse'));
    assert.ok(!codeMatches('', 'correct-horse'));
  });

  it('parses bearer headers strictly', () => {
    assert.equal(bearer('Bearer abc-123'), 'abc-123');
    assert.equal(bearer('bearer abc'), null);
    assert.equal(bearer('Bearer a b'), null);
    assert.equal(bearer(undefined), null);
  });

  it('sessions expire, can be revoked, and only well-formed signed tokens pass', () => {
    let t = 0;
    const s = new SessionStore('code-1', 1000, 10, () => t);
    const { token, maxAgeSec } = s.create();
    assert.equal(maxAgeSec, 1);
    assert.ok(s.valid(token));
    assert.ok(!s.valid(`${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`));
    assert.ok(!s.valid('short'));
    t = 1000;
    assert.ok(!s.valid(token), 'expired');
    const second = s.create();
    s.revoke(second.token);
    assert.ok(!s.valid(second.token));
  });

  it('a session survives a restart, but not a new access code (D-084)', () => {
    const before = new SessionStore('code-1', 60_000, 10, () => 0);
    const { token } = before.create();
    // a new process (Render free sleep or redeploy) with the same code accepts it
    assert.ok(new SessionStore('code-1', 60_000, 10, () => 1).valid(token));
    // the owner changed DEMO_ACCESS_CODE: every session ends
    assert.ok(!new SessionStore('code-2', 60_000, 10, () => 1).valid(token));
  });

  it('a later expiry cannot be forged by editing the token', () => {
    const s = new SessionStore('code-1', 1000, 10, () => 0);
    const { token } = s.create();
    const [nonce, , mac] = token.split('.');
    assert.ok(!s.valid(`${nonce}.99999999999999.${mac}`));
  });

  it('cookie attributes: HttpOnly, Path=/api; SameSite=None only with Secure', () => {
    assert.equal(
      sessionCookie('t', 60, { secure: false, crossSite: false }),
      'ae_session=t; HttpOnly; Path=/api; Max-Age=60; SameSite=Strict',
    );
    assert.equal(
      sessionCookie('t', 60, { secure: false, crossSite: true }),
      'ae_session=t; HttpOnly; Path=/api; Max-Age=60; SameSite=None; Secure',
    );
    assert.deepEqual(
      [...parseCookies('a=1; ae_session=xyz; junk').entries()],
      [
        ['a', '1'],
        ['ae_session', 'xyz'],
      ],
    );
  });
});

describe('clientAddress', () => {
  it('uses the socket unless proxies are trusted; then the entry the last trusted proxy added', () => {
    assert.equal(clientAddress('10.0.0.1', '1.2.3.4', 0), '10.0.0.1');
    assert.equal(clientAddress('10.0.0.1', 'spoofed, 1.2.3.4', 1), '1.2.3.4');
    assert.equal(clientAddress('10.0.0.1', 'spoofed, 1.2.3.4, 10.0.0.9', 2), '1.2.3.4');
    assert.equal(clientAddress('10.0.0.1', undefined, 1), '10.0.0.1');
  });

  it('toJson writes bigints as strings', () => {
    assert.equal(toJson({ a: 1n }), '{"a":"1"}');
  });
});

const run = (id: string): Run => ({
  id,
  trigger: 'manual',
  watchlist: ['x'],
  status: 'QUEUED',
  createdAt: '2026-10-27T12:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  error: null,
});

function fakeExecutor() {
  const log: string[] = [];
  let n = 0;
  let release: (() => void) | null = null;
  const executor: RunExecutor = {
    queue: () => run(`00000000-0000-4000-8000-00000000000${++n}`),
    async execute(id, options) {
      log.push(`start ${id.slice(-1)} ${options?.budget ?? '-'}`);
      await new Promise<void>((r) => {
        release = r;
      });
      log.push(`end ${id.slice(-1)}`);
      if (id.endsWith('3')) throw new Error('could not record');
      return { run: run(id), report: null };
    },
    checkBudget: (b) => {
      if (b !== undefined && b > 100n) throw new RangeError('budget too high');
    },
    recoverInterrupted: () => [],
  };
  return { executor, log, release: () => release?.() };
}

describe('TaskRunner', () => {
  it('runs tasks one at a time, in order, with their budgets', async () => {
    const f = fakeExecutor();
    const errors: string[] = [];
    const r = new TaskRunner(f.executor, { maxPending: 2, onError: (id) => errors.push(id) });
    assert.equal(r.submit({ trigger: 'manual', watchlist: ['a'] }, 50n).position, 1);
    assert.equal(r.submit({ trigger: 'manual', watchlist: ['b'] }).position, 2);
    assert.equal(r.submit({ trigger: 'manual', watchlist: ['c'] }).position, 3);
    assert.throws(() => r.submit({ trigger: 'manual', watchlist: ['d'] }), QueueFullError);
    assert.deepEqual(r.status(), { running: '00000000-0000-4000-8000-000000000001', pending: 2 });
    for (let i = 0; i < 3; i += 1) {
      await new Promise((x) => setImmediate(x));
      f.release();
    }
    await r.idle();
    assert.deepEqual(f.log, ['start 1 50', 'end 1', 'start 2 -', 'end 2', 'start 3 -', 'end 3']);
    assert.deepEqual(errors, ['00000000-0000-4000-8000-000000000003']);
    assert.deepEqual(r.status(), { running: null, pending: 0 });
  });

  it('drop() forgets waiting tasks; the running one finishes', async () => {
    const f = fakeExecutor();
    const r = new TaskRunner(f.executor);
    r.submit({ trigger: 'manual', watchlist: ['a'] });
    const waiting = r.submit({ trigger: 'manual', watchlist: ['b'] });
    assert.deepEqual(r.drop(), [waiting.run.id]);
    await new Promise((x) => setImmediate(x));
    f.release();
    await r.idle();
    assert.deepEqual(f.log, ['start 1 -', 'end 1']);
  });

  it('refuses a budget above the configured one before queueing anything', () => {
    const f = fakeExecutor();
    const r = new TaskRunner(f.executor);
    assert.throws(() => r.submit({ trigger: 'manual', watchlist: ['a'] }, 101n), RangeError);
    assert.deepEqual(r.status(), { running: null, pending: 0 });
  });
});
