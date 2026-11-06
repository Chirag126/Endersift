// Needs the workspace link to @agent-economy/core (CI and owner's machine).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EnvValidationError } from '@agent-economy/core';
import { loadServerConfig } from '../src/config.ts';

describe('server config (fail fast)', () => {
  it('loads defaults and freezes the result', () => {
    const cfg = loadServerConfig({});
    assert.equal(cfg.port, 3001);
    assert.equal(cfg.nodeEnv, 'development');
    assert.equal(cfg.databasePath, './data/agent-economy.db');
    assert.equal(cfg.demoAccessCode, null);
    assert.equal(cfg.corsOrigin, null);
    assert.equal(cfg.trustProxyHops, 0);
    assert.ok(Object.isFrozen(cfg));
    const behindRender = loadServerConfig({
      API_TRUST_PROXY_HOPS: '1',
      API_CORS_ORIGIN: 'https://app.example',
    });
    assert.equal(behindRender.trustProxyHops, 1);
    assert.equal(behindRender.corsOrigin, 'https://app.example');
    assert.throws(() => loadServerConfig({ API_TRUST_PROXY_HOPS: '9' }), /API_TRUST_PROXY_HOPS/);
  });

  it('deployment settings (D-062): defaults off; the daily brief is all three or none', () => {
    const local = loadServerConfig({});
    assert.equal(local.databaseEphemeral, false);
    assert.equal(local.webDistDir, null);
    assert.equal(local.providerWakeSec, 0);
    assert.equal(local.providerWakeOrigin, null);
    assert.equal(local.dailyBrief, null);
    const render = loadServerConfig({
      DATABASE_EPHEMERAL: 'true',
      WEB_DIST_DIR: 'apps/web/dist',
      PROVIDER_WAKE_SEC: '90',
      PROVIDER_WAKE_ORIGIN: 'https://threat-intel-providers.onrender.com',
      DAILY_BRIEF_WATCHLIST: 'OpenSSL, lodash@4.17.21 (npm)',
      DAILY_BRIEF_RUN_AFTER: '00:15',
      DAILY_BRIEF_BUDGET_TINYBARS: '300000',
    });
    assert.equal(render.databaseEphemeral, true);
    assert.equal(render.webDistDir, 'apps/web/dist');
    assert.equal(render.providerWakeSec, 90);
    assert.equal(render.providerWakeOrigin, 'https://threat-intel-providers.onrender.com');
    assert.deepEqual(render.dailyBrief, {
      watchlist: 'OpenSSL, lodash@4.17.21 (npm)',
      runAfter: '00:15',
      budget: 300_000n,
    });
    assert.throws(
      () => loadServerConfig({ DAILY_BRIEF_WATCHLIST: 'OpenSSL' }),
      /must be set together/,
    );
    assert.throws(
      () =>
        loadServerConfig({
          DAILY_BRIEF_WATCHLIST: 'OpenSSL',
          DAILY_BRIEF_RUN_AFTER: '25:00',
          DAILY_BRIEF_BUDGET_TINYBARS: '1',
        }),
      /DAILY_BRIEF_RUN_AFTER/,
    );
    assert.throws(() => loadServerConfig({ DATABASE_EPHEMERAL: 'yes' }), /DATABASE_EPHEMERAL/);
    assert.throws(() => loadServerConfig({ PROVIDER_WAKE_SEC: '301' }), /PROVIDER_WAKE_SEC/);
    // an origin only: no path, so the CSP entry and the /health URL stay exact (D-085)
    assert.throws(
      () => loadServerConfig({ PROVIDER_WAKE_ORIGIN: 'https://p.example/health' }),
      /PROVIDER_WAKE_ORIGIN/,
    );
  });

  it('refuses bad env, listing every problem without echoing values', () => {
    const bad = {
      SERVER_PORT: '99999',
      NODE_ENV: 'staging',
      LOG_LEVEL: 'loud',
      DEMO_ACCESS_CODE: 'short',
    };
    try {
      loadServerConfig(bad);
      assert.fail('expected EnvValidationError');
    } catch (error) {
      assert.ok(error instanceof EnvValidationError);
      for (const name of ['SERVER_PORT', 'NODE_ENV', 'LOG_LEVEL', 'DEMO_ACCESS_CODE'])
        assert.match(error.message, new RegExp(name));
      for (const value of ['99999', 'staging', 'loud', 'short'])
        assert.ok(!error.message.includes(value), value);
    }
  });

  it('requires DEMO_ACCESS_CODE in production', () => {
    assert.throws(
      () => loadServerConfig({ NODE_ENV: 'production' }),
      /DEMO_ACCESS_CODE is required when NODE_ENV=production/,
    );
    const code = 'a-long-demo-code-' + 'x'.repeat(8);
    assert.equal(
      loadServerConfig({ NODE_ENV: 'production', DEMO_ACCESS_CODE: code }).demoAccessCode,
      code,
    );
  });
});
