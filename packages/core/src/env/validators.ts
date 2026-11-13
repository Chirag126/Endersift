/**
 * Value validators for environment variables.
 *
 * Every validator returns `null` when the value is acceptable, or a short
 * reason string when it is not. Reasons NEVER include the value itself, so
 * they are safe to print even for secret variables.
 */

export type Validator = (value: string) => string | null;

export const oneOf =
  (allowed: readonly string[]): Validator =>
  (value) =>
    allowed.includes(value) ? null : `must be one of: ${allowed.join(', ')}`;

export const nonEmpty: Validator = (value) =>
  value.trim().length > 0 ? null : 'must not be empty';

export const minLength =
  (n: number): Validator =>
  (value) =>
    value.length >= n ? null : `must be at least ${n} characters`;

export const port: Validator = (value) => {
  if (!/^\d+$/.test(value)) return 'must be an integer port number';
  const n = Number(value);
  return n >= 1 && n <= 65535 ? null : 'must be between 1 and 65535';
};

const LOCALHOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** HTTPS URL. Plain HTTP is accepted only for localhost when `allowLocalHttp` is set. */
export const url =
  (options: { allowLocalHttp?: boolean } = {}): Validator =>
  (value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return 'must be a valid absolute URL';
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return 'must not embed credentials in the URL userinfo';
    }
    if (parsed.protocol === 'https:') return null;
    if (
      parsed.protocol === 'http:' &&
      options.allowLocalHttp === true &&
      LOCALHOST_NAMES.has(parsed.hostname)
    ) {
      return null;
    }
    return options.allowLocalHttp === true
      ? 'must use https (http is allowed only for localhost)'
      : 'must use https';
  };

/**
 * A browser origin for CORS: an allowed URL (see `url`) that is exactly
 * scheme://host[:port]. Browsers send `Origin` without a path or trailing
 * slash, so "https://app.example/" would never match and CORS would fail
 * silently; it is refused at startup instead (D-060).
 */
export const origin: Validator = (value) => {
  const problem = url({ allowLocalHttp: true })(value);
  if (problem !== null) return problem;
  return new URL(value).origin === value
    ? null
    : 'must be an origin only: scheme://host[:port], with no path, query or trailing slash';
};

/** Positive integer in atomic units (e.g. tinybars), as a decimal string without sign or exponent. */
export const positiveIntegerString: Validator = (value) =>
  /^[1-9]\d{0,17}$/.test(value) ? null : 'must be a positive whole number (atomic units)';

/** Integer within [min, max], as a plain decimal string. */
export const integerInRange =
  (min: number, max: number): Validator =>
  (value) => {
    if (!/^\d+$/.test(value)) return 'must be a whole number';
    const n = Number(value);
    return n >= min && n <= max ? null : `must be between ${min} and ${max}`;
  };

/**
 * Opaque credential with a fixed prefix (e.g. 0G's sk- API keys and mk-
 * management keys). Checks shape only; the reason never echoes the value.
 */
export const prefixedKey =
  (prefix: string, what: string): Validator =>
  (value) => {
    if (!value.startsWith(prefix)) return `must be a ${what} starting with ${prefix}`;
    if (value.length < prefix.length + 8) return `is too short to be a ${what}`;
    return /\s/.test(value) ? 'must not contain whitespace' : null;
  };

/** Hedera entity ID in shard.realm.num form, e.g. 0.0.12345 (also used for HTS token IDs). */
export const hederaEntityId: Validator = (value) =>
  /^0\.0\.\d+$/.test(value) ? null : 'must be a Hedera entity ID like 0.0.12345';

export interface LabelledAccount {
  readonly label: string;
  readonly accountId: string;
}

const PROVIDER_LABEL = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * Parse `label:0.0.N,label:0.0.N`. Labels are lowercase DNS-label-like names
 * (they become ENS subname labels later); labels and account IDs must be unique.
 * Returns the parsed list or a reason string.
 */
export function parseLabelledAccounts(value: string): LabelledAccount[] | string {
  const trimmed = value.trim();
  if (trimmed === '') return [];
  const result: LabelledAccount[] = [];
  const labels = new Set<string>();
  const ids = new Set<string>();
  for (const part of trimmed.split(',')) {
    const pieces = part.split(':').map((piece) => piece.trim());
    if (pieces.length === 1) {
      return 'each entry needs a label before the account ID, e.g. kev:0.0.12345';
    }
    const [label, accountId] = pieces;
    if (pieces.length !== 2 || label === undefined || accountId === undefined) {
      return 'entries must look like label:0.0.12345, separated by commas';
    }
    if (!PROVIDER_LABEL.test(label)) {
      return 'labels must be 2-31 chars: lowercase letters, digits, hyphens, starting with a letter';
    }
    if (!/^0\.0\.\d+$/.test(accountId)) return 'account IDs must look like 0.0.12345';
    if (labels.has(label)) return 'labels must be unique';
    if (ids.has(accountId)) return 'account IDs must be unique';
    labels.add(label);
    ids.add(accountId);
    result.push({ label, accountId });
  }
  return result;
}

export const labelledAccounts: Validator = (value) => {
  const parsed = parseLabelledAccounts(value);
  if (typeof parsed === 'string') return parsed;
  return parsed.length === 0 ? 'must list at least one label:account entry' : null;
};

/**
 * Hedera private key encodings accepted by the Hedera SDK string parsers:
 *  - raw 32-byte hex (64 hex chars, optional 0x prefix), type given separately
 *  - DER-encoded hex with the ECDSA secp256k1 or ED25519 prefix
 */
export const HEDERA_DER_PREFIX = {
  ecdsa: '3030020100300706052b8104000a04220420',
  ed25519: '302e020100300506032b657004220420',
} as const;

export type HederaKeyType = keyof typeof HEDERA_DER_PREFIX;

export function detectHederaKeyEncoding(value: string): 'raw' | HederaKeyType | null {
  const hex = value.toLowerCase().startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const lower = hex.toLowerCase();
  if (lower.length === 64) return 'raw';
  for (const [type, prefix] of Object.entries(HEDERA_DER_PREFIX) as [HederaKeyType, string][]) {
    if (lower.length === prefix.length + 64 && lower.startsWith(prefix)) return type;
  }
  return null;
}

export const hederaPrivateKey: Validator = (value) =>
  detectHederaKeyEncoding(value) === null
    ? 'must be a hex Hedera private key (raw 32-byte hex, or DER-encoded ECDSA/ED25519)'
    : null;

/** EVM private key: 0x followed by 64 hex characters. */
export const evmPrivateKey: Validator = (value) =>
  /^0x[0-9a-fA-F]{64}$/.test(value) ? null : 'must be 0x followed by 64 hex characters';

/**
 * Lowercase ENS name ending in .eth, with non-empty labels separated by dots.
 * Full UTS-46 normalisation is applied by the ENS library at use time; this
 * check only rejects obviously malformed configuration.
 */
export const ensEthName: Validator = (value) => {
  if (value !== value.toLowerCase()) return 'must be lowercase';
  if (!value.endsWith('.eth')) return 'must end with .eth';
  const labels = value.split('.');
  if (labels.some((label) => label.length === 0)) return 'must not contain empty labels';
  if (/\s/.test(value)) return 'must not contain whitespace';
  return null;
};

/** A UUID (NVD API keys are issued in this form). */
export const uuid: Validator = (value) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
    ? null
    : 'must be a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)';

const NEAR_ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** A NEAR account id: 2-64 characters, lowercase parts joined by dots. */
export function isNearAccountId(value: string): boolean {
  return value.length >= 2 && value.length <= 64 && NEAR_ACCOUNT_ID.test(value);
}

export const nearAccountId: Validator = (value) =>
  isNearAccountId(value) ? null : 'must be a NEAR account ID like agent.example.testnet';

/** NEAR's secret key text: ed25519:<base58>, as near-cli and wallets export it. */
export const nearSecretKey: Validator = (value) =>
  /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(value)
    ? null
    : 'must be a NEAR ed25519 secret key (ed25519:<base58>)';

/**
 * Parse `label:account.testnet,label:account.testnet` (NEAR payout accounts
 * by provider label). Returns the parsed list or a reason string.
 */
export function parseNearLabelledAccounts(value: string): LabelledAccount[] | string {
  const trimmed = value.trim();
  if (trimmed === '') return [];
  const result: LabelledAccount[] = [];
  const labels = new Set<string>();
  const ids = new Set<string>();
  for (const part of trimmed.split(',')) {
    const pieces = part.split(':').map((piece) => piece.trim());
    const [label, accountId] = pieces;
    if (pieces.length !== 2 || label === undefined || accountId === undefined)
      return 'entries must look like label:account.testnet, separated by commas';
    if (!PROVIDER_LABEL.test(label))
      return 'labels must be 2-31 chars: lowercase letters, digits, hyphens, starting with a letter';
    if (!isNearAccountId(accountId)) return 'account IDs must be NEAR account IDs';
    if (labels.has(label)) return 'labels must be unique';
    if (ids.has(accountId)) return 'account IDs must be unique';
    labels.add(label);
    ids.add(accountId);
    result.push({ label, accountId });
  }
  return result;
}

export const nearLabelledAccounts: Validator = (value) => {
  const parsed = parseNearLabelledAccounts(value);
  if (typeof parsed === 'string') return parsed;
  return parsed.length === 0 ? 'must list at least one label:account entry' : null;
};

/** A positive NEAR amount in decimal form, e.g. 0.001 (at most 24 decimals). */
export const nearAmount: Validator = (value) =>
  /^\d{1,15}(\.\d{1,24})?$/.test(value) && /[1-9]/.test(value)
    ? null
    : 'must be a positive NEAR amount like 0.001';
