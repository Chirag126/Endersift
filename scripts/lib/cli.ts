/**
 * Shared helpers for repo scripts: arguments, local .env loading, evidence files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EnvValidationError,
  dotenvToRecord,
  parseDotenv,
  type EnvSource,
} from '../../packages/core/src/index.ts';
import { scanText } from './secret-patterns.ts';

export function argValue(flag: string, argv: readonly string[] = process.argv): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/** A bad flag or a missing optional setting: printed as one line, no stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function hasFlag(flag: string, argv: readonly string[] = process.argv): boolean {
  return argv.includes(flag);
}

/**
 * Local .env merged under real environment variables (real env wins, matching
 * deployment behaviour). Parse problems are reported with line numbers only.
 *
 * Duplicate keys are fatal: the first occurrence wins, so a later corrected
 * line would otherwise be silently ignored (this happened on 2026-10-26).
 */
export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvFileError';
  }
}

export function loadLocalEnvSource(file = '.env'): EnvSource {
  let fileValues: Record<string, string> = {};
  if (existsSync(file)) {
    const parsed = parseDotenv(readFileSync(file, 'utf8'));
    const duplicates = parsed.errors.filter((e) => e.includes('duplicate key'));
    for (const e of parsed.errors) {
      if (!duplicates.includes(e)) console.warn(`warning: ${file} ${e}`);
    }
    if (duplicates.length > 0) {
      throw new EnvFileError(
        `${file} defines a key more than once (only the FIRST line counts):\n` +
          duplicates.map((d) => `  - ${d}`).join('\n') +
          `\nDelete the extra lines so each key appears exactly once.`,
      );
    }
    fileValues = dotenvToRecord(parsed);
  } else {
    console.warn(`warning: ${file} not found; using the process environment only.`);
  }
  return { ...fileValues, ...process.env };
}

/** UTC timestamp safe for file names on every OS, e.g. 20261026T031500Z. */
export function fileStamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export class EvidenceLeakError extends Error {
  constructor(findings: string[]) {
    super(`refusing to write evidence: possible secret detected (${findings.join(', ')})`);
    this.name = 'EvidenceLeakError';
  }
}

/** Serialise evidence, converting bigint values to decimal strings. */
export function evidenceJson(data: unknown): string {
  return `${JSON.stringify(data, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`;
}

/**
 * Write an evidence file under docs/evidence/<track>/. The serialised content
 * is run through the secret scanner first; anything key-like aborts the write.
 * Returns the path written.
 */
export function writeEvidence(
  track: string,
  name: string,
  data: unknown,
  root = 'docs/evidence',
): string {
  const text = evidenceJson(data);
  const findings = scanText(text);
  if (findings.length > 0) throw new EvidenceLeakError(findings.map((f) => f.ruleId));
  const path = join(root, track, `${name}-${fileStamp()}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

/**
 * Print configuration errors as a short message (names and reasons only, never
 * values) instead of a stack trace. Other errors keep their stack, since those
 * are bugs. Call once at the top of a script.
 */
const EXPECTED_ERROR_NAMES = new Set([
  'AmbiguousSendError',
  'WiringError',
  'ZgTransportError',
  'ZgRouterError',
  'ZgResponseError',
  'HttpJsonError',
  'MirrorNodeError',
  'EnvFileError',
  'EnsNameError',
  'RegistrationStateError',
  'MigrationError',
  'AgentManifestError',
  'OperatorKeyFileError',
  'DeploymentFileError',
  'ProvisionError',
  'PermissionTestError',
  'DiscoveryError',
  'DiscoveryProofError',
  'ProviderStartupError',
  'PaymentConfigError',
  'LedgerError',
  'UsageError',
  'PolicyError',
  'PaymentStateError',
  'PaymentStoreError',
  'StaleTransitionError',
  'NetGuardError',
  'SeedScheduleError',
  'StaticSiteError',
  'NearRpcError',
  'GuardKeyError',
  'NearSetupError',
]);

/**
 * Keep only scheme and host of every URL in error output. RPC URLs carry the
 * provider API key in their path (Alchemy /v2/<key>, Infura /v3/<key>), and
 * libraries such as viem echo the request URL in their error messages.
 */
export function redactUrls(text: string): string {
  return text.replace(/\b(https?|wss?):\/\/([^/\s"'?#]+)[^\s"']*/g, '$1://$2/…');
}

export function handleScriptErrors(): void {
  process.on('uncaughtException', (error: unknown) => {
    if (error instanceof Error && error.name === 'EnsMismatchError') {
      // Public values only (prices, account IDs, credential-free endpoints): printed unredacted so
      // endpoint paths stay comparable.
      console.error(`\n${error.name}: ${error.message}`);
    } else if (error instanceof Error && EXPECTED_ERROR_NAMES.has(error.name)) {
      // Network/service failures are environmental, not bugs: one clear line.
      console.error(redactUrls(`\n${error.name}: ${error.message}`));
    } else if (error instanceof EnvValidationError || error instanceof EvidenceLeakError) {
      console.error(`\n${error.message}`);
      if (error instanceof EnvValidationError) {
        console.error('\nFix your .env, then check it with: pnpm env:check');
      }
    } else if (error instanceof Error) {
      // Unexpected errors keep their stack, with URL paths (possible API keys) removed.
      console.error(redactUrls(error.stack ?? `${error.name}: ${error.message}`));
    } else {
      console.error(redactUrls(String(error)));
    }
    process.exit(1);
  });
}
