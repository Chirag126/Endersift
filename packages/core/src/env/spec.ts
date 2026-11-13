/**
 * Single source of truth for every environment variable the project reads.
 *
 * `.env.example` is checked against this list in CI (scripts/check-env-example.ts),
 * so the template can never drift from what the code actually expects.
 *
 * Groups let each integration be configured and tested independently: a
 * process loads only the groups it needs, so a missing 0G key never blocks a
 * Hedera-only test, and the ENS admin key is never required by the server.
 */
import {
  ensEthName,
  evmPrivateKey,
  hederaEntityId,
  hederaPrivateKey,
  labelledAccounts,
  minLength,
  nearAccountId,
  nearAmount,
  nearLabelledAccounts,
  nearSecretKey,
  nonEmpty,
  oneOf,
  origin,
  integerInRange,
  port,
  positiveIntegerString,
  prefixedKey,
  url,
  type Validator,
  uuid,
} from './validators.ts';

export const ENV_GROUPS = [
  'core',
  'hedera-network',
  'hedera',
  'hedera-providers',
  'x402',
  'providers',
  'ens',
  'ens-admin',
  'zg-network',
  'zg',
  'near',
  'near-agent',
  'near-providers',
  'near-admin',
  'web',
] as const;
export type EnvGroup = (typeof ENV_GROUPS)[number];

/**
 * Groups that are always loaded together with another group. Loading the payer
 * (`hedera`) or `x402` without knowing the network would be meaningless.
 */
export const GROUP_DEPENDENCIES: Readonly<Partial<Record<EnvGroup, readonly EnvGroup[]>>> = {
  hedera: ['hedera-network'],
  'hedera-providers': ['hedera-network'],
  x402: ['hedera-network'],
  providers: ['x402', 'hedera-providers'],
  'ens-admin': ['ens'],
  zg: ['zg-network'],
  'near-agent': ['near'],
  'near-providers': ['near'],
  'near-admin': ['near'],
};

/** The requested groups plus everything they depend on, in ENV_GROUPS order. */
export function expandGroups(groups: readonly EnvGroup[]): EnvGroup[] {
  const wanted = new Set<EnvGroup>();
  const visit = (g: EnvGroup): void => {
    if (wanted.has(g)) return;
    wanted.add(g);
    for (const dep of GROUP_DEPENDENCIES[g] ?? []) visit(dep);
  };
  groups.forEach(visit);
  return ENV_GROUPS.filter((g) => wanted.has(g));
}

export interface EnvVarSpec {
  readonly name: string;
  readonly group: EnvGroup;
  /** Required when its group is loaded. A default makes it effectively optional. */
  readonly required: boolean;
  /** Secret values must be empty in .env.example and are never printed. */
  readonly secret: boolean;
  readonly default?: string;
  readonly description: string;
  readonly validate?: Validator;
}

export const ENV_SPEC = [
  // ── core ──────────────────────────────────────────────────────────────
  {
    name: 'NODE_ENV',
    group: 'core',
    required: true,
    secret: false,
    default: 'development',
    description: 'Runtime mode.',
    validate: oneOf(['development', 'test', 'production']),
  },
  {
    name: 'LOG_LEVEL',
    group: 'core',
    required: true,
    secret: false,
    default: 'info',
    description: 'Minimum log level.',
    validate: oneOf(['debug', 'info', 'warn', 'error']),
  },
  {
    name: 'SERVER_PORT',
    group: 'core',
    required: true,
    secret: false,
    default: '3001',
    description: 'Port for the API server. 3001 is one of the Privy-allowed localhost ports.',
    validate: port,
  },
  {
    name: 'DATABASE_PATH',
    group: 'core',
    required: true,
    secret: false,
    default: './data/agent-economy.db',
    description: 'SQLite database file path.',
    validate: nonEmpty,
  },
  {
    name: 'DEMO_ACCESS_CODE',
    group: 'core',
    required: false,
    secret: true,
    description:
      'Shared code required to start paid/inference-consuming runs on a public deployment.',
    validate: minLength(12),
  },
  {
    name: 'API_CORS_ORIGIN',
    group: 'core',
    required: false,
    secret: false,
    description:
      'Frontend origin allowed to call the API with credentials (CORS), e.g. https://app.example (no trailing slash). Empty = same origin only.',
    validate: origin,
  },
  {
    name: 'API_TRUST_PROXY_HOPS',
    group: 'core',
    required: true,
    secret: false,
    default: '0',
    description:
      'Reverse proxies in front of the API whose X-Forwarded-For entries are trusted (Render: 1; local: 0).',
    validate: integerInRange(0, 3),
  },
  {
    name: 'DATABASE_EPHEMERAL',
    group: 'core',
    required: false,
    secret: false,
    description:
      'true when the host wipes the database file on restart (Render free plan, D-062): the UI says so and the scheduler only catches up shortly after its time.',
    validate: oneOf(['true', 'false']),
  },
  {
    name: 'WEB_DIST_DIR',
    group: 'core',
    required: false,
    secret: false,
    description:
      'Built web app folder the API serves at / on the same origin (deployment: apps/web/dist). Empty = API only.',
    validate: nonEmpty,
  },
  {
    name: 'PROVIDER_WAKE_SEC',
    group: 'core',
    required: false,
    secret: false,
    description:
      'Seconds a run keeps retrying an unreachable provider catalog while a sleeping provider host wakes (Render free: 90). Empty = no retry.',
    validate: integerInRange(0, 300),
  },
  {
    name: 'PROVIDER_WAKE_ORIGIN',
    group: 'core',
    required: false,
    secret: false,
    description:
      "Origin of the provider host the web app wakes from the visitor's browser (D-085): it fetches <origin>/health on load and every few minutes while open. Render free answers 429 to the agent's own requests while the host sleeps. Empty = no wake.",
    validate: origin,
  },
  {
    name: 'DAILY_BRIEF_WATCHLIST',
    group: 'core',
    required: false,
    secret: false,
    description:
      'Daily brief created at startup if missing (deployment without a disk, D-062): comma-separated watchlist. Needs DAILY_BRIEF_RUN_AFTER and DAILY_BRIEF_BUDGET_TINYBARS.',
    validate: nonEmpty,
  },
  {
    name: 'DAILY_BRIEF_RUN_AFTER',
    group: 'core',
    required: false,
    secret: false,
    description: 'Time of day (UTC, HH:MM) after which the env-seeded daily brief runs.',
    validate: (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? null : 'must be HH:MM (UTC)'),
  },
  {
    name: 'DAILY_BRIEF_BUDGET_TINYBARS',
    group: 'core',
    required: false,
    secret: false,
    description: 'Budget of each env-seeded daily brief, in tinybars (at most the run budget).',
    validate: positiveIntegerString,
  },

  // ── hedera-network (no secrets: which network, where to verify) ────────
  {
    name: 'HEDERA_NETWORK',
    group: 'hedera-network',
    required: true,
    secret: false,
    default: 'testnet',
    description: 'Hedera network the agent pays on.',
    validate: oneOf(['testnet', 'mainnet']),
  },
  {
    name: 'HEDERA_MIRROR_NODE_URL',
    group: 'hedera-network',
    required: true,
    secret: false,
    default: 'https://testnet.mirrornode.hedera.com',
    description: 'Mirror Node REST base URL used to independently verify settlement.',
    validate: url(),
  },

  // ── hedera (payer account used by the autonomous agent) ───────────────
  {
    name: 'HEDERA_PAYER_ACCOUNT_ID',
    group: 'hedera',
    required: true,
    secret: false,
    description: 'Real 0.0.x account ID of the agent payer (aliases are not accepted).',
    validate: hederaEntityId,
  },
  {
    name: 'HEDERA_PAYER_PRIVATE_KEY',
    group: 'hedera',
    required: true,
    secret: true,
    description: 'Private key of the payer account (hex or DER hex). Server-side only.',
    validate: hederaPrivateKey,
  },
  {
    name: 'HCS_TOPIC_ID',
    group: 'hedera',
    required: false,
    secret: false,
    description:
      'HCS audit topic (0.0.N) created by pnpm hcs:create-topic. Set: each settlement and task digest is posted to it, paid by the payer account. Unset: no audit messages.',
    validate: hederaEntityId,
  },
  {
    name: 'HEDERA_PAYER_KEY_TYPE',
    group: 'hedera',
    required: true,
    secret: false,
    default: 'ecdsa',
    description: 'Key algorithm of the payer key.',
    validate: oneOf(['ecdsa', 'ed25519']),
  },

  // ── hedera-providers (payout accounts of the paid data providers) ─────
  {
    name: 'HEDERA_PROVIDER_ACCOUNTS',
    group: 'hedera-providers',
    required: true,
    secret: false,
    description:
      'Provider payout accounts as label:0.0.N pairs, e.g. kev:0.0.1,cve:0.0.2. Created by `pnpm hedera:create-providers`.',
    validate: labelledAccounts,
  },

  // ── x402 ──────────────────────────────────────────────────────────────
  {
    name: 'X402_FACILITATOR_URL',
    group: 'x402',
    required: true,
    secret: false,
    default: 'https://api.testnet.blocky402.com',
    description: 'Primary x402 facilitator (listed in Hedera docs).',
    validate: url(),
  },
  {
    name: 'X402_FALLBACK_FACILITATOR_URL',
    group: 'x402',
    required: false,
    secret: false,
    default: 'https://x402.org/facilitator',
    description: 'Fallback facilitator used only for verify/settle when the primary is down.',
    validate: url(),
  },
  {
    name: 'X402_NETWORK',
    group: 'x402',
    required: true,
    secret: false,
    default: 'hedera:testnet',
    description: 'CAIP-2 network identifier payments must settle on.',
    validate: oneOf(['hedera:testnet', 'hedera:mainnet']),
  },
  {
    name: 'X402_ASSET',
    group: 'x402',
    required: true,
    secret: false,
    default: '0.0.0',
    description: 'Settlement asset: 0.0.0 is HBAR, otherwise an HTS token ID.',
    validate: hederaEntityId,
  },

  {
    name: 'X402_MAX_PAYMENT_TINYBARS',
    group: 'x402',
    required: true,
    secret: false,
    default: '1000000',
    description:
      'Client-side cap per payment in tinybars (1000000 = 0.01 HBAR). Quotes above it are refused before signing.',
    validate: positiveIntegerString,
  },
  {
    name: 'X402_RUN_BUDGET_TINYBARS',
    group: 'x402',
    required: true,
    secret: false,
    default: '3000000',
    description:
      'Spending firewall: most one run may commit (settled + in flight + unknown), in tinybars (3000000 = 0.03 HBAR). Must be >= X402_MAX_PAYMENT_TINYBARS.',
    validate: positiveIntegerString,
  },
  {
    name: 'X402_DAILY_BUDGET_TINYBARS',
    group: 'x402',
    required: true,
    secret: false,
    default: '10000000',
    description:
      'Spending firewall: most all runs may commit per UTC day, in tinybars (10000000 = 0.1 HBAR). Must be >= X402_RUN_BUDGET_TINYBARS.',
    validate: positiveIntegerString,
  },
  {
    name: 'X402_MAX_PAYMENTS_PER_RUN',
    group: 'x402',
    required: true,
    secret: false,
    default: '10',
    description: 'Spending firewall: maximum number of payments one run may start.',
    validate: integerInRange(1, 100),
  },
  {
    name: 'X402_SNAPSHOT_MAX_AGE_SEC',
    group: 'x402',
    required: true,
    secret: false,
    default: '600',
    description:
      'Spending firewall: how old the ENS discovery snapshot may be when a purchase is authorised (seconds).',
    validate: integerInRange(30, 86400),
  },
  {
    name: 'X402_PAYMENTS_PAUSED',
    group: 'x402',
    required: false,
    secret: false,
    description:
      'true = the firewall refuses every payment and new tasks do not start, whatever the owner saved in the UI. The lasting kill switch on a host that wipes its database (D-062).',
    validate: oneOf(['true', 'false']),
  },
  {
    name: 'APPROVAL_TIMEOUT_SEC',
    group: 'x402',
    required: false,
    secret: false,
    description:
      'Human approval mode (D-066): seconds the owner has to approve a payment before it expires unsigned. Default 600.',
    validate: integerInRange(30, 3600),
  },
  {
    name: 'AGENT_EARNINGS_ACCOUNT',
    group: 'x402',
    required: false,
    secret: false,
    description:
      "The agent's own Hedera account that buyers of its brief pay (D-066). Never a provider payout account or the payer. Empty = the brief is not for sale.",
    validate: hederaEntityId,
  },

  // ── providers (paid x402 services; never needs the payer key) ─────────
  {
    name: 'PROVIDERS_PORT',
    group: 'providers',
    required: true,
    secret: false,
    default: '4021',
    description: 'Port for the x402-protected provider services (bound to 127.0.0.1).',
    validate: port,
  },
  {
    name: 'X402_DEMO_PRICE_TINYBARS',
    group: 'providers',
    required: true,
    secret: false,
    default: '100000',
    description: 'Price of the Phase 3 paid route in tinybars (100000 = 0.001 HBAR).',
    validate: positiveIntegerString,
  },
  {
    name: 'PROVIDERS_PUBLIC_URL',
    group: 'providers',
    required: false,
    secret: false,
    description:
      'Public base URL of the provider service (ENS agent.endpoint = <this>/v1/<label>). Default http://127.0.0.1:<PROVIDERS_PORT>; set the https URL after deployment.',
    validate: url({ allowLocalHttp: true }),
  },
  {
    name: 'X402_USDC_PING_ATOMIC',
    group: 'providers',
    required: false,
    secret: false,
    description:
      "USDC lane (plan row 37): price of /v1/<label>/ping-usdc in USDC atomic units (6 decimals; 10000 = 0.01 USDC), paid in the network's Circle USDC token. Empty = no USDC route.",
    validate: positiveIntegerString,
  },
  {
    name: 'BRIEF_SALE_PRICE_TINYBARS',
    group: 'providers',
    required: false,
    secret: false,
    description:
      "The agent earns (D-066): price in tinybars of /v1/agent/brief, the agent's latest brief sold over x402 to AGENT_EARNINGS_ACCOUNT. Needs AGENT_PUBLIC_URL. Empty = not for sale.",
    validate: positiveIntegerString,
  },
  {
    name: 'AGENT_PUBLIC_URL',
    group: 'providers',
    required: false,
    secret: false,
    description:
      "The agent's public base URL, where the brief for sale is read (GET /api/briefs/latest). https except http://localhost in development.",
    validate: url({ allowLocalHttp: true }),
  },
  {
    name: 'NVD_API_KEY',
    group: 'providers',
    required: false,
    secret: true,
    description:
      'Optional NVD API key (free at nvd.nist.gov). Raises the cve provider limit from 5 to 50 NVD requests per 30 s.',
    validate: uuid,
  },

  // ── ens (read path, used by the server) ───────────────────────────────
  {
    name: 'ENS_CHAIN',
    group: 'ens',
    required: true,
    secret: false,
    default: 'sepolia',
    description: 'Ethereum network carrying the ENSv2 deployment.',
    validate: oneOf(['sepolia', 'mainnet']),
  },
  {
    name: 'ETH_RPC_URL',
    group: 'ens',
    required: true,
    secret: true,
    description: 'Ethereum JSON-RPC URL for ENS_CHAIN. Usually embeds a provider API key.',
    validate: url(),
  },
  {
    name: 'ENS_PARENT_NAME',
    group: 'ens',
    required: true,
    secret: false,
    description: 'Parent .eth name under which provider agents are registered as subnames.',
    validate: ensEthName,
  },
  {
    name: 'ENS_DISCOVERY_FROM_BLOCK',
    group: 'ens',
    required: false,
    secret: false,
    description:
      'Block where the ENS log scan starts (the subregistry deployment block). Unset = search for it, which costs many RPC calls on free plans. A --from-block flag overrides it.',
    validate: positiveIntegerString,
  },

  // ── ens-admin (provisioning scripts only; never loaded by the server) ─
  {
    name: 'ENS_ADMIN_PRIVATE_KEY',
    group: 'ens-admin',
    required: true,
    secret: true,
    description:
      'EVM key that owns ENS_PARENT_NAME. Used only by local provisioning scripts, never deployed.',
    validate: evmPrivateKey,
  },
  {
    name: 'ENS_AGENT_ENDPOINT_BASE',
    group: 'ens-admin',
    required: true,
    secret: false,
    default: 'http://127.0.0.1:4021',
    description:
      'Base URL published as each agent endpoint (<base>/v1/<label>). Local until the Render deployment (D-031); re-provision with the https URL then.',
    validate: url({ allowLocalHttp: true }),
  },

  // ── zg-network (no secrets: which 0G Router, enough to read the catalog) ─
  {
    name: 'ZG_NETWORK',
    group: 'zg-network',
    required: true,
    secret: false,
    default: 'mainnet',
    description:
      '0G Private Computer environment. mainnet = pc.0g.ai (team/iAI credits); testnet = pc.testnet.0g.ai (faucet 0G).',
    validate: oneOf(['mainnet', 'testnet']),
  },
  {
    name: 'ZG_ROUTER_BASE_URL',
    group: 'zg-network',
    required: true,
    secret: false,
    default: 'https://router-api.0g.ai/v1',
    description:
      '0G Router, OpenAI-compatible base URL. Testnet: https://router-api-testnet.integratenetwork.work/v1',
    validate: url(),
  },

  // ── zg (0G Private Computer inference) ────────────────────────────────
  {
    name: 'ZG_API_KEY',
    group: 'zg',
    required: true,
    secret: true,
    description: 'Router API key (sk-...) from pc.0g.ai Dashboard → API Keys. Inference only.',
    validate: prefixedKey('sk-', '0G Router API key'),
  },
  {
    name: 'ZG_MANAGEMENT_KEY',
    group: 'zg',
    required: false,
    secret: true,
    description:
      'Optional management key (mk-...) with the account:read scope, for balance/usage evidence. Never used for inference.',
    validate: prefixedKey('mk-', '0G management key'),
  },
  {
    name: 'ZG_MODEL',
    group: 'zg',
    required: true,
    secret: false,
    description:
      'Model ID from the live catalog (pnpm zg:models). No default: the catalog changes.',
    validate: nonEmpty,
  },
  {
    name: 'ZG_OUTPUT_LIMIT',
    group: 'zg',
    required: true,
    secret: false,
    default: '256',
    description: 'max_tokens sent with every inference call (completion length cap).',
    validate: integerInRange(1, 8192),
  },
  {
    name: 'ZG_MAX_CALL_COST_NEURON',
    group: 'zg',
    required: true,
    secret: false,
    default: '1000000000000000',
    description:
      'Refuse a call whose worst-case cost from catalog prices exceeds this (neuron; 1e18 = 1 0G; default 0.001 0G).',
    validate: positiveIntegerString,
  },
  {
    name: 'ZG_TIMEOUT_MS',
    group: 'zg',
    required: true,
    secret: false,
    default: '60000',
    description:
      'Timeout for one inference call (ms). A timed-out call is reported as outcome unknown and never retried.',
    validate: integerInRange(5000, 600000),
  },
  {
    name: 'ZG_DAILY_CAP_NEURON',
    group: 'zg',
    required: true,
    secret: false,
    default: '10000000000000000',
    description:
      'Daily inference cap per UTC day (neuron; default 0.01 0G). A call is refused unless spent today + its worst case fits (D-040). Must be >= ZG_MAX_CALL_COST_NEURON.',
    validate: positiveIntegerString,
  },
  {
    name: 'ZG_SNAPSHOT_INTERVAL_MIN',
    group: 'zg',
    required: true,
    secret: false,
    default: '60',
    description:
      'Minutes between Router balance snapshots (pnpm ledger:snapshot -- --every, and the server job). Needs ZG_MANAGEMENT_KEY.',
    validate: integerInRange(5, 1440),
  },
  {
    name: 'ZG_STT_MODEL',
    group: 'zg',
    required: true,
    secret: false,
    default: 'whisper-large-v3',
    description:
      'Speech-to-text model for the voice task (D-076), as the live catalog names it (mainnet: whisper-large-v3; pnpm zg:models), or off. The 0G testnet has no speech model. If it is off or not in the catalog, voice input is switched off and the rest of the agent runs. One mainnet clip may bill up to ~0.28 0G (D-080).',
    validate: nonEmpty,
  },
  {
    name: 'ZG_STT_MAX_NEURON',
    group: 'zg',
    required: true,
    secret: false,
    default: '1000000000000000',
    description:
      'Worst case reserved against the daily cap for one voice transcription (neuron; default 0.001 0G). The catalog gives no per-clip price, so this fixed amount is reserved; the real cost from the Router is recorded. Must be <= ZG_DAILY_CAP_NEURON.',
    validate: positiveIntegerString,
  },

  // ── near (no secrets: which NEAR network and which guard contract) ────
  {
    name: 'NEAR_NETWORK',
    group: 'near',
    required: true,
    secret: false,
    default: 'testnet',
    description: 'NEAR network the guard contract is deployed on.',
    validate: oneOf(['testnet', 'mainnet']),
  },
  {
    name: 'NEAR_NODE_URL',
    group: 'near',
    required: true,
    secret: false,
    default: 'https://test.rpc.fastnear.com',
    description:
      'NEAR JSON-RPC endpoint (docs.near.org/api/rpc/providers). The default is a free public testnet node.',
    validate: url({ allowLocalHttp: true }),
  },
  {
    name: 'NEAR_GUARD_CONTRACT_ID',
    group: 'near',
    required: true,
    secret: false,
    description:
      'Account of the spending guard contract (contracts/guard): the provider registry, the caps and the receipts.',
    validate: nearAccountId,
  },

  // ── near-agent (the agent's function-call key) ────────────────────────
  {
    name: 'NEAR_AGENT_ACCOUNT_ID',
    group: 'near-agent',
    required: true,
    secret: false,
    description: 'The agent account the guard contract accepts pay() from.',
    validate: nearAccountId,
  },
  {
    name: 'NEAR_AGENT_PRIVATE_KEY',
    group: 'near-agent',
    required: true,
    secret: true,
    description:
      "The agent's function-call access key, scoped to the guard contract. It cannot transfer NEAR, add keys or call another contract. The agent refuses to start with a full-access key.",
    validate: nearSecretKey,
  },
  {
    name: 'NEAR_MIN_ACCOUNT_AGE_BLOCKS',
    group: 'near-agent',
    required: true,
    secret: false,
    default: '86400',
    description:
      'Counterparty check: a receiver that has held a key for fewer blocks than this, with no passed delivery yet, is a warning (about one block per second).',
    validate: integerInRange(0, 100000000),
  },

  // ── near-providers (the NEAR pay lane of the provider service) ────────
  {
    name: 'NEAR_PROVIDER_ACCOUNTS',
    group: 'near-providers',
    required: true,
    secret: false,
    description:
      'NEAR payout account of each provider, by label: kev:kev.example.testnet,cve:... The same accounts the guard registry lists.',
    validate: nearLabelledAccounts,
  },
  {
    name: 'NEAR_PRICE',
    group: 'near-providers',
    required: true,
    secret: false,
    default: '0.001',
    description: 'Price of one paid request on the NEAR lane, in NEAR.',
    validate: nearAmount,
  },

  // ── near-admin (local only: the owner key that sets everything up) ────
  {
    name: 'NEAR_OWNER_ACCOUNT_ID',
    group: 'near-admin',
    required: true,
    secret: false,
    description:
      'The owner account: it creates the guard, agent and provider sub-accounts and owns the guard contract.',
    validate: nearAccountId,
  },
  {
    name: 'NEAR_OWNER_PRIVATE_KEY',
    group: 'near-admin',
    required: true,
    secret: true,
    description:
      "The owner's full-access key. Used only by pnpm near:setup on your machine. Never deployed.",
    validate: nearSecretKey,
  },

  // ── web (public; bundled into the browser) ────────────────────────────
  {
    name: 'VITE_API_BASE_URL',
    group: 'web',
    required: true,
    secret: false,
    default: 'http://localhost:3001',
    description: 'API base URL the browser calls.',
    validate: url({ allowLocalHttp: true }),
  },
  {
    name: 'VITE_PRIVY_APP_ID',
    group: 'web',
    required: false,
    secret: false,
    description:
      "0G's Privy app ID for the holder lane. Works only on localhost:3000/3001/5173 per 0G.",
    validate: nonEmpty,
  },
] as const satisfies readonly EnvVarSpec[];

export type EnvName = (typeof ENV_SPEC)[number]['name'];

/** Prefix that marks a variable as bundled into browser code. */
export const PUBLIC_PREFIX = 'VITE_';
