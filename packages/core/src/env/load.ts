/**
 * Load and validate environment variables for a chosen set of groups.
 *
 * Fails fast with ALL problems at once. Error messages contain variable names
 * and reasons only, never values, so they are safe to log.
 */
import { detectHederaKeyEncoding, parseLabelledAccounts } from './validators.ts';
import { ENV_SPEC, expandGroups, type EnvGroup, type EnvName, type EnvVarSpec } from './spec.ts';

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type EnvVarStatus = 'ok' | 'default' | 'missing' | 'invalid' | 'unset-optional';

export interface EnvVarReport {
  readonly name: EnvName;
  readonly group: EnvGroup;
  readonly secret: boolean;
  readonly status: EnvVarStatus;
  readonly reason?: string;
}

export interface EnvReport {
  readonly groups: readonly EnvGroup[];
  readonly vars: readonly EnvVarReport[];
  /** Problems spanning several variables, e.g. network mismatches. */
  readonly crossFieldErrors: readonly string[];
  readonly ok: boolean;
}

export class EnvValidationError extends Error {
  readonly report: EnvReport;
  constructor(report: EnvReport) {
    super(formatEnvProblems(report));
    this.name = 'EnvValidationError';
    this.report = report;
  }
}

export interface LoadedEnv {
  readonly groups: readonly EnvGroup[];
  /** Value of a variable from a loaded group, or undefined if optional and unset. */
  get(name: EnvName): string | undefined;
  /** Value of a variable from a loaded group; throws if it is unset. */
  require(name: EnvName): string;
}

/** Documented Router API hosts (docs.0g.ai Router overview, 2026-10-26). */
export const ZG_ROUTER_HOSTS = {
  mainnet: 'router-api.0g.ai',
  testnet: 'router-api-testnet.integratenetwork.work',
} as const;

const SPEC_BY_NAME: ReadonlyMap<string, EnvVarSpec> = new Map(
  (ENV_SPEC as readonly EnvVarSpec[]).map((spec) => [spec.name, spec]),
);

function resolveValue(spec: EnvVarSpec, source: EnvSource): string | undefined {
  const raw = source[spec.name];
  if (raw !== undefined && raw.trim() !== '') return raw.trim();
  return spec.default;
}

/** Validate without throwing. Used by `pnpm env:check` and by `loadEnv`. */
export function checkEnv(requested: readonly EnvGroup[], source: EnvSource): EnvReport {
  const groups = expandGroups(requested);
  const wanted = new Set(groups);
  const specs = (ENV_SPEC as readonly EnvVarSpec[]).filter((s) => wanted.has(s.group));
  const values = new Map<string, string>();

  const vars: EnvVarReport[] = specs.map((spec) => {
    const raw = source[spec.name];
    const provided = raw !== undefined && raw.trim() !== '';
    const value = resolveValue(spec, source);
    const base = { name: spec.name as EnvName, group: spec.group, secret: spec.secret };

    if (value === undefined) {
      return spec.required
        ? { ...base, status: 'missing', reason: 'is required but not set' }
        : { ...base, status: 'unset-optional' };
    }
    const reason = spec.validate?.(value) ?? null;
    if (reason !== null) return { ...base, status: 'invalid', reason };
    values.set(spec.name, value);
    return { ...base, status: provided ? 'ok' : 'default' };
  });

  const crossFieldErrors = crossFieldChecks(wanted, values);
  const ok =
    crossFieldErrors.length === 0 &&
    vars.every((v) => v.status !== 'missing' && v.status !== 'invalid');
  return { groups: [...groups], vars, crossFieldErrors, ok };
}

function crossFieldChecks(
  groups: ReadonlySet<EnvGroup>,
  values: ReadonlyMap<string, string>,
): string[] {
  const errors: string[] = [];
  const network = values.get('HEDERA_NETWORK');

  if (groups.has('core')) {
    const brief = ['DAILY_BRIEF_WATCHLIST', 'DAILY_BRIEF_RUN_AFTER', 'DAILY_BRIEF_BUDGET_TINYBARS'];
    const set = brief.filter((name) => values.get(name) !== undefined);
    if (set.length > 0 && set.length < brief.length)
      errors.push(`${brief.join(', ')} must be set together (or all left empty)`);
  }

  if (groups.has('hedera-network') && groups.has('x402')) {
    const x402Network = values.get('X402_NETWORK');
    if (network !== undefined && x402Network !== undefined && x402Network !== `hedera:${network}`) {
      errors.push('X402_NETWORK must match HEDERA_NETWORK (expected hedera:<HEDERA_NETWORK>)');
    }
  }

  if (groups.has('hedera-network')) {
    const mirror = values.get('HEDERA_MIRROR_NODE_URL');
    if (network !== undefined && mirror !== undefined) {
      const other = network === 'testnet' ? 'mainnet' : 'testnet';
      if (new URL(mirror).hostname.includes(other)) {
        errors.push(`HEDERA_MIRROR_NODE_URL points at ${other} but HEDERA_NETWORK is ${network}`);
      }
    }
  }

  if (groups.has('hedera')) {
    const key = values.get('HEDERA_PAYER_PRIVATE_KEY');
    const keyType = values.get('HEDERA_PAYER_KEY_TYPE');
    if (key !== undefined && keyType !== undefined) {
      const encoding = detectHederaKeyEncoding(key);
      if (encoding !== null && encoding !== 'raw' && encoding !== keyType) {
        errors.push(
          `HEDERA_PAYER_PRIVATE_KEY is DER-encoded ${encoding} but HEDERA_PAYER_KEY_TYPE is ${keyType}`,
        );
      }
    }
  }

  if (groups.has('hedera') && groups.has('hedera-providers')) {
    const payer = values.get('HEDERA_PAYER_ACCOUNT_ID');
    const providers = values.get('HEDERA_PROVIDER_ACCOUNTS');
    if (payer !== undefined && providers !== undefined) {
      const parsed = parseLabelledAccounts(providers);
      if (typeof parsed !== 'string' && parsed.some((p) => p.accountId === payer)) {
        errors.push(
          'HEDERA_PROVIDER_ACCOUNTS must not contain HEDERA_PAYER_ACCOUNT_ID (no self-payment)',
        );
      }
    }
  }

  if (groups.has('x402')) {
    // the agent's earnings account (D-066) is neither the payer nor a provider payout account
    const earnings = values.get('AGENT_EARNINGS_ACCOUNT');
    const payer = values.get('HEDERA_PAYER_ACCOUNT_ID');
    const providers = values.get('HEDERA_PROVIDER_ACCOUNTS');
    if (earnings !== undefined && payer !== undefined && earnings === payer)
      errors.push('AGENT_EARNINGS_ACCOUNT must not be HEDERA_PAYER_ACCOUNT_ID');
    if (earnings !== undefined && providers !== undefined) {
      const parsed = parseLabelledAccounts(providers);
      if (typeof parsed !== 'string' && parsed.some((p) => p.accountId === earnings))
        errors.push('AGENT_EARNINGS_ACCOUNT must not be a provider payout account');
    }
  }

  if (groups.has('providers')) {
    // selling the brief (D-066) needs where to pay and where to read it
    if (values.get('BRIEF_SALE_PRICE_TINYBARS') !== undefined) {
      if (values.get('AGENT_EARNINGS_ACCOUNT') === undefined)
        errors.push('BRIEF_SALE_PRICE_TINYBARS needs AGENT_EARNINGS_ACCOUNT (who is paid)');
      if (values.get('AGENT_PUBLIC_URL') === undefined)
        errors.push('BRIEF_SALE_PRICE_TINYBARS needs AGENT_PUBLIC_URL (where the brief is read)');
    }
  }

  if (groups.has('zg-network')) {
    const zgNetwork = values.get('ZG_NETWORK');
    const base = values.get('ZG_ROUTER_BASE_URL');
    if (zgNetwork !== undefined && base !== undefined) {
      const host = new URL(base).hostname;
      const knownFor = Object.entries(ZG_ROUTER_HOSTS).find(([, h]) => h === host)?.[0];
      if (knownFor !== undefined && knownFor !== zgNetwork) {
        errors.push(`ZG_ROUTER_BASE_URL is the ${knownFor} Router but ZG_NETWORK is ${zgNetwork}`);
      }
    }
  }

  if (groups.has('x402')) {
    const num = (n: string) => {
      const v = values.get(n);
      return v !== undefined && /^\d+$/.test(v) ? BigInt(v) : null;
    };
    const perPayment = num('X402_MAX_PAYMENT_TINYBARS');
    const perRun = num('X402_RUN_BUDGET_TINYBARS');
    const perDay = num('X402_DAILY_BUDGET_TINYBARS');
    if (perPayment !== null && perRun !== null && perRun < perPayment)
      errors.push('X402_RUN_BUDGET_TINYBARS must be >= X402_MAX_PAYMENT_TINYBARS');
    if (perRun !== null && perDay !== null && perDay < perRun)
      errors.push('X402_DAILY_BUDGET_TINYBARS must be >= X402_RUN_BUDGET_TINYBARS');
  }

  if (groups.has('zg')) {
    const perCall = values.get('ZG_MAX_CALL_COST_NEURON');
    const daily = values.get('ZG_DAILY_CAP_NEURON');
    if (
      perCall !== undefined &&
      daily !== undefined &&
      /^\d+$/.test(perCall) &&
      /^\d+$/.test(daily) &&
      BigInt(daily) < BigInt(perCall)
    ) {
      errors.push(
        'ZG_DAILY_CAP_NEURON must be >= ZG_MAX_CALL_COST_NEURON (one capped call must fit a day)',
      );
    }
    const stt = values.get('ZG_STT_MAX_NEURON');
    if (
      stt !== undefined &&
      daily !== undefined &&
      /^\d+$/.test(stt) &&
      /^\d+$/.test(daily) &&
      BigInt(daily) < BigInt(stt)
    ) {
      errors.push(
        'ZG_DAILY_CAP_NEURON must be >= ZG_STT_MAX_NEURON (one voice transcription must fit a day)',
      );
    }
  }

  return errors;
}

export function formatEnvProblems(report: EnvReport): string {
  const lines = report.vars
    .filter((v) => v.status === 'missing' || v.status === 'invalid')
    .map((v) => `  - ${v.name} ${v.reason ?? ''}`.trimEnd());
  for (const error of report.crossFieldErrors) lines.push(`  - ${error}`);
  if (lines.length === 0) return 'Environment is valid.';
  return `Invalid environment for groups [${report.groups.join(', ')}]:\n${lines.join('\n')}`;
}

/** Load the requested groups or throw EnvValidationError listing every problem. */
export function loadEnv(groups: readonly EnvGroup[], source: EnvSource = process.env): LoadedEnv {
  const report = checkEnv(groups, source);
  if (!report.ok) throw new EnvValidationError(report);

  const loaded = new Set(report.groups);
  const lookup = (name: EnvName): string | undefined => {
    const spec = SPEC_BY_NAME.get(name);
    if (spec === undefined || !loaded.has(spec.group)) {
      throw new Error(`${name} belongs to a group that was not loaded`);
    }
    return resolveValue(spec, source);
  };

  return {
    groups: report.groups,
    get: lookup,
    require(name) {
      const value = lookup(name);
      if (value === undefined) throw new Error(`${name} is not set`);
      return value;
    },
  };
}
