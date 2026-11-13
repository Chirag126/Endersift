// Class: unit. render.yaml must stay deployable and safe (D-062): every
// variable known to the env spec, no secret value in the file, the keys that
// are never deployed absent, and each service's env complete for the groups
// it loads (only the secrets asked for in the dashboard may be missing).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ENV_SPEC, checkEnv, type EnvGroup } from '../../packages/core/src/index.ts';

interface Service {
  readonly name: string;
  readonly fields: Map<string, string>;
  /** key → value, or null for `sync: false` (asked for in the dashboard). */
  readonly env: Map<string, string | null>;
}

/** A small reader for this file's shape: services, scalar fields, envVars of key/value or sync. */
function readBlueprint(text: string): Service[] {
  const services: Service[] = [];
  let current: Service | null = null;
  let pendingKey: string | null = null;
  const scalar = (raw: string) => raw.trim().replace(/^'(.*)'$/, '$1');
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const start = /^ {2}- type: (\S+)$/.exec(line);
    if (start !== null) {
      current = { name: '', fields: new Map([['type', start[1] ?? '']]), env: new Map() };
      services.push(current);
      continue;
    }
    if (current === null) continue;
    const field = /^ {4}([a-zA-Z]+): (.+)$/.exec(line);
    if (field !== null) {
      if (field[1] === 'name') (current as { name: string }).name = scalar(field[2] ?? '');
      current.fields.set(field[1] ?? '', scalar(field[2] ?? ''));
      continue;
    }
    const key = /^ {6}- key: (\S+)$/.exec(line);
    if (key !== null) {
      pendingKey = key[1] ?? null;
      continue;
    }
    const value = /^ {8}(value|sync): (.+)$/.exec(line);
    if (value !== null && pendingKey !== null) {
      current.env.set(pendingKey, value[1] === 'sync' ? null : scalar(value[2] ?? ''));
      pendingKey = null;
    }
  }
  return services;
}

const services = readBlueprint(readFileSync('render.yaml', 'utf8'));
const byName = (name: string) => {
  const s = services.find((x) => x.name === name);
  assert.ok(s !== undefined, `render.yaml has no service ${name}`);
  return s;
};
const SPEC = new Map(ENV_SPEC.map((v) => [v.name, v]));
/** Variables Render itself reads; not part of the app's env spec. */
const RENDER_ONLY = new Set(['NODE_VERSION', 'PORT']);
const NEVER_DEPLOYED = [
  'ENS_ADMIN_PRIVATE_KEY',
  'ENS_AGENT_ENDPOINT_BASE',
  'ZG_MANAGEMENT_KEY',
  'NEAR_OWNER_PRIVATE_KEY',
];
/** The groups each process loads: apps/server LIVE_ENV_GROUPS; apps/providers core+providers+ens. */
const GROUPS: Readonly<Record<string, readonly EnvGroup[]>> = {
  endersift: ['core', 'hedera', 'ens', 'x402', 'zg'],
  'endersift-providers': ['core', 'providers', 'ens'],
};

describe('render.yaml (D-062)', () => {
  it('declares the two free web services with health checks', () => {
    assert.deepEqual(
      services.map((s) => s.name),
      ['endersift', 'endersift-providers'],
    );
    for (const s of services) {
      assert.equal(s.fields.get('type'), 'web', s.name);
      assert.equal(s.fields.get('runtime'), 'node', s.name);
      assert.equal(s.fields.get('plan'), 'free', s.name);
      assert.ok(s.env.size > 0, `${s.name} has no envVars`);
    }
    assert.equal(byName('endersift').fields.get('healthCheckPath'), '/api/health');
    assert.equal(byName('endersift-providers').fields.get('healthCheckPath'), '/health');
  });

  it('every variable is in the env spec (or read by Render itself)', () => {
    for (const s of services)
      for (const key of s.env.keys())
        assert.ok(SPEC.has(key as never) || RENDER_ONLY.has(key), `${s.name}: unknown ${key}`);
  });

  it('no secret has a value in the file: each is asked for in the dashboard', () => {
    for (const s of services)
      for (const [key, value] of s.env) {
        const spec = SPEC.get(key as never);
        if (spec?.secret === true)
          assert.equal(value, null, `${s.name}: ${key} must be sync: false`);
      }
  });

  it('the keys that are never deployed are absent; the providers never get the payer or 0G key', () => {
    for (const s of services)
      for (const key of NEVER_DEPLOYED) assert.ok(!s.env.has(key), `${s.name} has ${key}`);
    const providers = byName('endersift-providers');
    for (const key of ['HEDERA_PAYER_PRIVATE_KEY', 'ZG_API_KEY', 'DEMO_ACCESS_CODE'])
      assert.ok(!providers.env.has(key), `providers have ${key}`);
  });

  it("each service's env is complete for its groups: only dashboard secrets may be missing", () => {
    for (const s of services) {
      const source: Record<string, string> = {};
      for (const [k, v] of s.env) if (v !== null) source[k] = v;
      const report = checkEnv(GROUPS[s.name] ?? [], source);
      const asked = new Set([...s.env].filter(([, v]) => v === null).map(([k]) => k));
      const bad = report.vars.filter((v) => v.status === 'missing' || v.status === 'invalid');
      for (const v of bad)
        assert.ok(asked.has(v.name), `${s.name}: ${v.name} ${v.reason ?? v.status}`);
      assert.deepEqual(report.crossFieldErrors, [], s.name);
    }
  });

  it('the agent runs as deployed without a disk: production, one origin, wake-up, seeded brief', () => {
    const env = byName('endersift').env;
    assert.equal(env.get('NODE_ENV'), 'production');
    assert.equal(env.get('DATABASE_EPHEMERAL'), 'true');
    assert.equal(env.get('WEB_DIST_DIR'), 'apps/web/dist');
    assert.equal(env.get('API_TRUST_PROXY_HOPS'), '1');
    assert.equal(env.get('PORT'), env.get('SERVER_PORT'));
    assert.ok(
      Number(env.get('PROVIDER_WAKE_SEC')) >= 60,
      'a free provider host needs about a minute',
    );
    assert.ok(!env.has('API_CORS_ORIGIN'), 'same origin: no CORS');
    const providers = byName('endersift-providers').env;
    assert.equal(providers.get('NODE_ENV'), 'production');
    assert.equal(providers.get('PORT'), providers.get('PROVIDERS_PORT'));
    assert.equal(
      providers.get('PROVIDERS_PUBLIC_URL'),
      null,
      'its own URL is set in the dashboard',
    );
  });
});
