/**
 * Agent record schema: the ENS text records a provider agent publishes, and a
 * strict parser for them.
 *
 * Canonical keys (owner's plan, row 11): agent.endpoint, agent.capabilities,
 * agent.price, x402.payTo, x402.network, x402.asset, agent.status.
 * ENSIP-26 (draft) keys, where they apply:
 *   - agent-context           optional free-form description for agents
 *   - agent-endpoint[x402]    optional mirror of agent.endpoint (ENSIP-26 allows
 *                             new protocol values); must equal it when present
 * Plus ENSIP-5 `description` (optional, human-facing).
 *
 * Every value comes from chain state anyone can write to their own name, so it
 * is UNTRUSTED: trimmed, length-capped, control characters rejected, and
 * validated per key. The parser never throws on bad data; it returns every
 * problem so discovery can log and skip the agent. Dependency-free.
 */

export const AGENT_RECORD_KEYS = {
  endpoint: 'agent.endpoint',
  capabilities: 'agent.capabilities',
  price: 'agent.price',
  payTo: 'x402.payTo',
  network: 'x402.network',
  asset: 'x402.asset',
  status: 'agent.status',
  context: 'agent-context',
  endpointX402: 'agent-endpoint[x402]',
  description: 'description',
} as const;
export type AgentRecordKey = (typeof AGENT_RECORD_KEYS)[keyof typeof AGENT_RECORD_KEYS];

export interface RecordKeySpec {
  readonly key: AgentRecordKey;
  readonly required: boolean;
  readonly maxLength: number;
  readonly meaning: string;
  readonly example: string;
  /** Who may write it once permissions are delegated (Phase 11 plan, row 12). */
  readonly writer: 'admin' | 'operator';
}

/** The full spec, in publication order. Also rendered in docs/ens-records.md. */
export const AGENT_RECORD_SPEC: readonly RecordKeySpec[] = [
  {
    key: 'agent.endpoint',
    required: true,
    maxLength: 512,
    meaning: 'Base URL of the x402-protected data service (https; http only for local dev).',
    example: 'https://providers.example.com/v1/kev',
    writer: 'operator',
  },
  {
    key: 'agent.capabilities',
    required: true,
    maxLength: 512,
    meaning: 'Comma-separated capability slugs (lowercase, unique, 1–16).',
    example: 'known-exploited-vulns,cve-lookup',
    writer: 'operator',
  },
  {
    key: 'agent.price',
    required: true,
    maxLength: 40,
    meaning: 'Price per request in atomic units of x402.asset (tinybars for HBAR); integer > 0.',
    example: '100000',
    writer: 'operator',
  },
  {
    key: 'x402.payTo',
    required: true,
    maxLength: 32,
    meaning: 'Hedera account that must receive payment; quotes paying elsewhere are refused.',
    example: '0.0.11044329',
    writer: 'admin',
  },
  {
    key: 'x402.network',
    required: true,
    maxLength: 32,
    meaning: 'CAIP-2 network the payment must settle on.',
    example: 'hedera:testnet',
    writer: 'admin',
  },
  {
    key: 'x402.asset',
    required: true,
    maxLength: 32,
    meaning: 'Settlement asset: 0.0.0 for HBAR, otherwise an HTS token ID.',
    example: '0.0.0',
    writer: 'admin',
  },
  {
    key: 'agent.status',
    required: true,
    maxLength: 16,
    meaning: 'active (purchasable), paused (temporarily not), or retired.',
    example: 'active',
    writer: 'operator',
  },
  {
    key: 'agent-context',
    required: false,
    maxLength: 4000,
    meaning: 'ENSIP-26 agent description. Untrusted: delimited when shown to a model.',
    example: 'Serves CISA KEV entries matching a product watchlist.',
    writer: 'operator',
  },
  {
    key: 'agent-endpoint[x402]',
    required: false,
    maxLength: 512,
    meaning: 'ENSIP-26 endpoint for the x402 protocol; must equal agent.endpoint if set.',
    example: 'https://providers.example.com/v1/kev',
    writer: 'operator',
  },
  {
    key: 'description',
    required: false,
    maxLength: 500,
    meaning: 'ENSIP-5 human-facing description.',
    example: 'Provider agent "kev" (CISA KEV).',
    writer: 'operator',
  },
];

export const AGENT_STATUSES = ['active', 'paused', 'retired'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export const X402_NETWORKS = ['hedera:testnet', 'hedera:mainnet'] as const;
export type X402Network = (typeof X402_NETWORKS)[number];

export interface AgentRecords {
  readonly endpoint: string;
  readonly capabilities: readonly string[];
  readonly priceAtomic: string;
  readonly payTo: string;
  readonly network: X402Network;
  readonly asset: string;
  readonly status: AgentStatus;
  readonly context: string | null;
  readonly description: string | null;
}

export const RECORD_PROBLEM_CODES = [
  'MISSING',
  'TOO_LONG',
  'CONTROL_CHARS',
  'INVALID',
  'CONFLICT',
  'NETWORK_MISMATCH',
] as const;
export type RecordProblemCode = (typeof RECORD_PROBLEM_CODES)[number];

export interface RecordProblem {
  readonly key: AgentRecordKey;
  readonly code: RecordProblemCode;
  /** Never echoes the offending value (it is attacker-controlled). */
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly records: AgentRecords }
  | { readonly ok: false; readonly problems: readonly RecordProblem[] };

export interface ParseOptions {
  /** Allow http://localhost / 127.0.0.1 endpoints (local development only). */
  readonly allowLocalHttp?: boolean;
  /** When set, x402.network must equal it (e.g. the agent's configured X402_NETWORK). */
  readonly expectedNetwork?: X402Network;
}

const SPEC_BY_KEY = new Map(AGENT_RECORD_SPEC.map((s) => [s.key, s]));
const SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const HEDERA_ID = /^0\.0\.\d{1,19}$/;
const CANONICAL_POSITIVE = /^[1-9]\d{0,38}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function checkUrl(value: string, allowLocalHttp: boolean): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'is not a valid absolute URL';
  }
  if (u.username !== '' || u.password !== '') return 'must not embed credentials';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && allowLocalHttp && LOCAL_HOSTS.has(u.hostname)) return null;
  return allowLocalHttp ? 'must use https (http only for localhost)' : 'must use https';
}

/** Parse capability slugs; returns the sorted unique list or a reason. */
export function parseCapabilities(value: string): string[] | string {
  const parts = value.split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === ''))
    return 'must be comma-separated slugs with no empty entries';
  if (parts.length > 16) return 'must list at most 16 capabilities';
  for (const p of parts) if (!SLUG.test(p)) return 'each capability must be a lowercase slug';
  if (new Set(parts).size !== parts.length) return 'capabilities must be unique';
  return [...parts].sort();
}

/**
 * Parse an agent's text records (as returned by resolution; null = unset).
 * Collects every problem rather than stopping at the first.
 */
export function parseAgentRecords(
  raw: Readonly<Record<string, string | null | undefined>>,
  options: ParseOptions = {},
): ParseResult {
  const problems: RecordProblem[] = [];
  const values = new Map<AgentRecordKey, string>();
  const problem = (key: AgentRecordKey, code: RecordProblemCode, message: string) =>
    problems.push({ key, code, message: `${key} ${message}` });

  for (const spec of AGENT_RECORD_SPEC) {
    const v = raw[spec.key];
    const value = typeof v === 'string' ? v.trim() : '';
    if (value === '') {
      if (spec.required) problem(spec.key, 'MISSING', 'is required but not set');
      continue;
    }
    if (value.length > spec.maxLength) {
      problem(spec.key, 'TOO_LONG', `exceeds ${spec.maxLength} characters`);
      continue;
    }
    if (CONTROL.test(value)) {
      problem(spec.key, 'CONTROL_CHARS', 'contains control characters');
      continue;
    }
    values.set(spec.key, value);
  }

  const get = (k: AgentRecordKey) => values.get(k);
  const allowLocalHttp = options.allowLocalHttp === true;

  const endpoint = get('agent.endpoint');
  if (endpoint !== undefined) {
    const why = checkUrl(endpoint, allowLocalHttp);
    if (why !== null) problem('agent.endpoint', 'INVALID', why);
  }
  const mirror = get('agent-endpoint[x402]');
  if (mirror !== undefined) {
    const why = checkUrl(mirror, allowLocalHttp);
    if (why !== null) problem('agent-endpoint[x402]', 'INVALID', why);
    else if (endpoint !== undefined && mirror !== endpoint) {
      problem('agent-endpoint[x402]', 'CONFLICT', 'differs from agent.endpoint');
    }
  }

  let capabilities: string[] = [];
  const caps = get('agent.capabilities');
  if (caps !== undefined) {
    const parsed = parseCapabilities(caps);
    if (typeof parsed === 'string') problem('agent.capabilities', 'INVALID', parsed);
    else capabilities = parsed;
  }

  const price = get('agent.price');
  if (price !== undefined && !CANONICAL_POSITIVE.test(price)) {
    problem('agent.price', 'INVALID', 'must be a canonical positive integer in atomic units');
  }

  for (const key of ['x402.payTo', 'x402.asset'] as const) {
    const v = get(key);
    if (v !== undefined && !HEDERA_ID.test(v))
      problem(key, 'INVALID', 'must be a Hedera entity ID like 0.0.12345');
  }

  const network = get('x402.network');
  if (network !== undefined) {
    if (!(X402_NETWORKS as readonly string[]).includes(network)) {
      problem('x402.network', 'INVALID', `must be one of ${X402_NETWORKS.join(', ')}`);
    } else if (options.expectedNetwork !== undefined && network !== options.expectedNetwork) {
      problem(
        'x402.network',
        'NETWORK_MISMATCH',
        `is not the expected network ${options.expectedNetwork}`,
      );
    }
  }

  const status = get('agent.status');
  if (status !== undefined && !(AGENT_STATUSES as readonly string[]).includes(status)) {
    problem('agent.status', 'INVALID', `must be one of ${AGENT_STATUSES.join(', ')}`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    records: {
      endpoint: endpoint as string,
      capabilities,
      priceAtomic: price as string,
      payTo: get('x402.payTo') as string,
      network: network as X402Network,
      asset: get('x402.asset') as string,
      status: status as AgentStatus,
      context: get('agent-context') ?? null,
      description: get('description') ?? null,
    },
  };
}

/**
 * Canonical text values to publish (used by provisioning). Always writes the
 * ENSIP-26 x402 endpoint mirror; omits optional keys that are null. The
 * result is re-parsed so nothing invalid is ever written.
 */
export function agentRecordsToText(
  records: AgentRecords,
  options: ParseOptions = {},
): Partial<Record<AgentRecordKey, string>> {
  const out: Partial<Record<AgentRecordKey, string>> = {
    'agent.endpoint': records.endpoint,
    'agent-endpoint[x402]': records.endpoint,
    'agent.capabilities': [...new Set(records.capabilities)].sort().join(','),
    'agent.price': records.priceAtomic,
    'x402.payTo': records.payTo,
    'x402.network': records.network,
    'x402.asset': records.asset,
    'agent.status': records.status,
  };
  if (records.context !== null) out['agent-context'] = records.context;
  if (records.description !== null) out.description = records.description;
  const check = parseAgentRecords(out, options);
  if (!check.ok) {
    const why = check.problems.map((p) => p.message).join('; ');
    throw new Error(`refusing to serialise invalid agent records: ${why}`);
  }
  return out;
}

/** All keys a reader should fetch for an agent. */
export const AGENT_RECORD_READ_KEYS: readonly AgentRecordKey[] = AGENT_RECORD_SPEC.map(
  (s) => s.key,
);

export function recordSpec(key: AgentRecordKey): RecordKeySpec {
  const spec = SPEC_BY_KEY.get(key);
  if (spec === undefined) throw new Error(`unknown agent record key ${key}`);
  return spec;
}
