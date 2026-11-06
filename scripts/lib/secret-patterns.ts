/**
 * Local secret detector, tuned to the credentials this project handles.
 *
 * This is a fast, dependency-free first line of defence that runs in the
 * pre-commit hook on any OS (including Windows without extra binaries).
 * CI additionally runs gitleaks over the full history. GitHub secret scanning
 * with push protection is enabled by the owner once the repository is public
 * (not available while it is private; docs/security-checklist.md).
 */

export interface SecretRule {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
}

export interface SecretFinding {
  readonly ruleId: string;
  readonly line: number;
  /** Redacted preview: never the full secret. */
  readonly preview: string;
}

/** A line containing this marker is skipped (use sparingly, explain in review). */
export const ALLOW_MARKER = 'secret-scan: allow';

// Values that are obviously placeholders or indirections, not secrets.
const NOT_A_LITERAL = String.raw`(?![<$]|process\.env|import\.meta\.env)`;

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'hedera-der-private-key',
    description: 'DER-encoded Hedera ECDSA or ED25519 private key',
    pattern: /(?:3030020100300706052b8104000a|302e020100300506032b6570)04220420[0-9a-f]{64}/i,
  },
  {
    id: 'pem-private-key',
    description: 'PEM private key block',
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
  },
  {
    id: 'assigned-credential',
    description: 'Credential-named variable assigned a literal value',
    pattern: new RegExp(
      String.raw`\b[A-Z0-9_]*(?:PRIVATE_KEY|SECRET|API_KEY|MANAGEMENT_KEY|ACCESS_TOKEN|AUTH_TOKEN|ACCESS_CODE)\s*[=:]\s*["'\x60]?` +
        NOT_A_LITERAL +
        String.raw`[^\s"'\x60#,;]{12,}`,
    ),
  },
  {
    id: 'hex-key-literal',
    description: 'Key-named identifier assigned a 32-byte hex literal',
    pattern:
      /\b(?:private[_-]?key|secret[_-]?key|signing[_-]?key|privKey)\b["']?\s*[:=]\s*["'`](?:0x)?[0-9a-f]{64}["'`]/i,
  },
  {
    id: 'bearer-style-api-key',
    description: 'sk-/mk- prefixed API key (0G Router API or management key, OpenAI-style)',
    pattern: /(?<![A-Za-z0-9_-])(?:sk|mk)-[A-Za-z0-9_-]{24,}/,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token (e.g. a Privy access token): bearer credential while valid',
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  },
  {
    id: 'rpc-url-with-key',
    description: 'Ethereum RPC URL embedding a provider API key',
    pattern: /(?:alchemy\.com\/v2\/[A-Za-z0-9_-]{16,}|infura\.io\/v3\/[0-9a-f]{32})/,
  },
];

function redact(match: string): string {
  return match.length <= 8 ? '[redacted]' : `${match.slice(0, 6)}…[redacted]`;
}

export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const rule of SECRET_RULES) {
      const match = rule.pattern.exec(line);
      if (match !== null) {
        findings.push({ ruleId: rule.id, line: index + 1, preview: redact(match[0]) });
      }
    }
  });
  return findings;
}

/** Heuristic: NUL byte in the first 8 KB means binary content we do not scan. */
export function looksBinary(content: Buffer): boolean {
  return content.subarray(0, 8192).includes(0);
}
