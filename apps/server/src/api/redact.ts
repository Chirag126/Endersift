/**
 * Redaction at the API boundary (D-053). Run events and error texts are
 * written by our own code and should never hold a secret, but they include
 * strings that came from outside (provider responses, error messages, URLs),
 * so everything the API sends from them passes through here first.
 *
 *   keys     a field whose name says it is a secret is replaced whole
 *   strings  credential-shaped substrings are replaced in any string:
 *            "Bearer …", Hedera DER private keys, sk-/pk- style API keys,
 *            secret-looking URL query parameters and URL user:password
 *
 * Deliberately narrow: transaction IDs, 0G request IDs, ENS names, account IDs,
 * block numbers and token COUNTS (maxTokens, promptTokens) stay visible,
 * because they are the evidence. Pure.
 */

export const REDACTED = '[redacted]';

const SENSITIVE_KEY_PARTS = [
  'privatekey',
  'secret',
  'password',
  'passphrase',
  'authorization',
  'apikey',
  'accesscode',
  'cookie',
  'bearer',
  'mnemonic',
  'seedphrase',
  'credential',
];

/** True for a field name that names a secret. "token" alone counts; "tokens" (a count) does not. */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_KEY_PARTS.some((part) => k.includes(part))) return true;
  return k.endsWith('token');
}

const SECRET_QUERY =
  /([?&](?:api[_-]?key|key|token|access[_-]?token|secret|signature|sig|auth|password)=)[^&#\s"']+/gi;

const PATTERNS: readonly (readonly [RegExp, string])[] = [
  // Authorization header values
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  // Hedera DER-encoded private keys (ED25519 and ECDSA secp256k1)
  [/(?:0x)?302e020100300506032b657004220420[0-9a-fA-F]{64}/g, REDACTED],
  [/(?:0x)?3030020100300706052b8104000a04220420[0-9a-fA-F]{64}/g, REDACTED],
  // a raw 0x-hex 32-byte secret (an EVM private key); run events record no 32-byte hashes
  [/\b0x[0-9a-fA-F]{64}\b/g, REDACTED],
  // sk-… / pk-… style API keys
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, REDACTED],
  // RPC provider keys carried in the URL path (Alchemy /v2/<key>, Infura /v3/<key>, D-054)
  [/(alchemy\.com\/v2\/)[A-Za-z0-9_-]{8,}/gi, `$1${REDACTED}`],
  [/(infura\.io\/v3\/)[A-Za-z0-9_-]{8,}/gi, `$1${REDACTED}`],
  // other hosted RPC endpoints put the key in the path: keep only the host
  [
    /(https?:\/\/[a-z0-9.-]*(?:quiknode\.pro|ankr\.com|chainstack\.com|blastapi\.io|drpc\.org|getblock\.io)\/)[^\s"']+/gi,
    `$1${REDACTED}`,
  ],
  // user:password@ in URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
  // secret-looking query parameters
  [SECRET_QUERY, `$1${REDACTED}`],
];

/** Credential-shaped substrings replaced. */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** A deep copy with secret fields and credential-shaped strings redacted. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return REDACTED;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k] = isSensitiveKey(k) && v !== null ? REDACTED : redactValue(v, depth + 1);
    return out;
  }
  return value;
}
