/**
 * Server configuration: built once at startup from validated env groups and
 * frozen. Fails fast: any missing or invalid variable stops the process with
 * every problem listed (names and reasons only, never values).
 *
 * The API server loads the live groups as well (apps/server/src/main.ts), so a
 * server that cannot pay or reason refuses to start rather than failing mid-run.
 */
import { EnvValidationError, loadEnv, type EnvReport, type EnvSource } from '@agent-economy/core';

export interface ServerConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly port: number;
  readonly databasePath: string;
  /** Required in production: paid and inference-consuming runs are gated by it. */
  readonly demoAccessCode: string | null;
  /** Frontend origin allowed by CORS with credentials, or null (same origin only). */
  readonly corsOrigin: string | null;
  /** Trusted reverse proxies in front of the API (Render: 1). */
  readonly trustProxyHops: number;
  /** The host wipes the database file on restart (Render free plan, D-062). */
  readonly databaseEphemeral: boolean;
  /** Built web app served at / by the API on the same origin, or null (API only). */
  readonly webDistDir: string | null;
  /** Seconds a run retries an unreachable provider catalog while its host wakes (0 = no retry). */
  readonly providerWakeSec: number;
  /** Provider host origin the web app wakes from the browser (D-085), or null. */
  readonly providerWakeOrigin: string | null;
  /** The daily brief created at startup if missing, or null (D-062). */
  readonly dailyBrief: {
    readonly watchlist: string;
    readonly runAfter: string;
    readonly budget: bigint;
  } | null;
}

export function loadServerConfig(source: EnvSource): ServerConfig {
  const env = loadEnv(['core'], source); // throws EnvValidationError listing every problem
  const nodeEnv = env.require('NODE_ENV') as ServerConfig['nodeEnv'];
  const demoAccessCode = env.get('DEMO_ACCESS_CODE') ?? null;
  if (nodeEnv === 'production' && demoAccessCode === null) {
    const report: EnvReport = {
      groups: ['core'],
      vars: [
        {
          name: 'DEMO_ACCESS_CODE',
          group: 'core',
          secret: true,
          status: 'missing',
          reason: 'is required when NODE_ENV=production (public runs spend real funds and credits)',
        },
      ],
      crossFieldErrors: [],
      ok: false,
    };
    throw new EnvValidationError(report);
  }
  return Object.freeze({
    nodeEnv,
    logLevel: env.require('LOG_LEVEL') as ServerConfig['logLevel'],
    port: Number(env.require('SERVER_PORT')),
    databasePath: env.require('DATABASE_PATH'),
    demoAccessCode,
    corsOrigin: env.get('API_CORS_ORIGIN') ?? null,
    trustProxyHops: Number(env.require('API_TRUST_PROXY_HOPS')),
    databaseEphemeral: env.get('DATABASE_EPHEMERAL') === 'true',
    webDistDir: env.get('WEB_DIST_DIR') ?? null,
    providerWakeSec: Number(env.get('PROVIDER_WAKE_SEC') ?? '0'),
    providerWakeOrigin: env.get('PROVIDER_WAKE_ORIGIN') ?? null,
    // set together or not at all (checked by loadEnv)
    dailyBrief:
      env.get('DAILY_BRIEF_WATCHLIST') === undefined
        ? null
        : Object.freeze({
            watchlist: env.require('DAILY_BRIEF_WATCHLIST'),
            runAfter: env.require('DAILY_BRIEF_RUN_AFTER'),
            budget: BigInt(env.require('DAILY_BRIEF_BUDGET_TINYBARS')),
          }),
  });
}
