/**
 * Holder-lane probe logic (pure, no DOM, unit-tested under Node).
 *
 * Question (plan row 6 / repo Phase 5): can an app that signs a 0G holder in
 * with 0G's Privy app ID reach that holder's Router account, and therefore,
 * potentially, spend their daily iAI credits?
 *
 * Hypothesis under test: 0G's Router accepts a Privy access token from 0G's
 * app as the "wallet JWT" its auth docs mention (docs.0g.ai Router
 * Authentication: management-key routes are "wallet JWT only"). We test it
 * with READ-ONLY calls:
 *   GET /v1/account/balance  → address, deposit_balance, total_balance
 *   GET /v1/api-keys         → whether the session could manage the holder's keys
 *
 * The access token is used in memory only. It never enters evidence: the
 * evidence builder refuses any JWT-shaped string.
 */

export type ZgNetwork = 'mainnet' | 'testnet';
export type AppIdKind = '0g' | 'own';

export interface JwtClaims {
  readonly iss: string | null;
  readonly aud: string | null;
  readonly exp: number | null;
}

/** Decode (NOT verify) a JWT payload, to record issuer/audience/expiry only. */
export function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json: unknown = JSON.parse(
      atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')),
    );
    if (typeof json !== 'object' || json === null) return null;
    const c = json as Record<string, unknown>;
    const aud = Array.isArray(c['aud']) ? c['aud'][0] : c['aud'];
    return {
      iss: typeof c['iss'] === 'string' ? c['iss'] : null,
      aud: typeof aud === 'string' ? aud : null,
      exp: typeof c['exp'] === 'number' ? c['exp'] : null,
    };
  } catch {
    return null;
  }
}

export interface RouterCall {
  readonly status: number | null;
  readonly body: unknown;
  readonly networkError?: string;
}

export interface BalanceReading {
  readonly address: string;
  readonly depositBalance: string;
  readonly totalBalance: string;
  /**
   * total − deposit, never negative. INFERRED as the credit part: the docs
   * define total_balance as "what is available to spend right now" and give
   * no separate credit field.
   */
  readonly inferredCreditPart: string;
}

export interface StepResult {
  readonly name: string;
  readonly status: number | null;
  readonly accepted: boolean;
  readonly detail: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function neuron(v: unknown): bigint | null {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return null;
}

function errorDetail(call: RouterCall): string {
  if (call.networkError !== undefined) return `network error: ${call.networkError}`;
  const err = isRecord(call.body) && isRecord(call.body['error']) ? call.body['error'] : null;
  const code = err !== null && typeof err['code'] === 'string' ? err['code'] : null;
  const type = err !== null && typeof err['type'] === 'string' ? err['type'] : null;
  return `HTTP ${call.status ?? '?'}${type !== null || code !== null ? ` ${[type, code].filter(Boolean).join('/')}` : ''}`;
}

export function interpretBalance(call: RouterCall): {
  step: StepResult;
  balance: BalanceReading | null;
} {
  const name = 'GET /v1/account/balance with the Privy access token';
  if (call.status !== 200 || !isRecord(call.body)) {
    return {
      step: { name, status: call.status, accepted: false, detail: errorDetail(call) },
      balance: null,
    };
  }
  const address = call.body['address'];
  const deposit = neuron(call.body['deposit_balance']);
  const total = neuron(call.body['total_balance']);
  if (
    typeof address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(address) ||
    deposit === null ||
    total === null
  ) {
    return {
      step: {
        name,
        status: 200,
        accepted: false,
        detail: 'HTTP 200 but the body is not a balance object',
      },
      balance: null,
    };
  }
  const credit = total > deposit ? total - deposit : 0n;
  return {
    step: { name, status: 200, accepted: true, detail: 'token accepted; balance returned' },
    balance: {
      address,
      depositBalance: deposit.toString(),
      totalBalance: total.toString(),
      inferredCreditPart: credit.toString(),
    },
  };
}

export function interpretKeyList(call: RouterCall): { step: StepResult; keyCount: number | null } {
  const name = 'GET /v1/api-keys with the Privy access token (read-only)';
  if (call.status !== 200) {
    return {
      step: { name, status: call.status, accepted: false, detail: errorDetail(call) },
      keyCount: null,
    };
  }
  const list = Array.isArray(call.body)
    ? call.body
    : isRecord(call.body) && Array.isArray(call.body['data'])
      ? call.body['data']
      : null;
  return {
    step: {
      name,
      status: 200,
      accepted: list !== null,
      detail:
        list === null
          ? 'HTTP 200 but not a list'
          : `token accepted; ${list.length} key(s) listed (contents not recorded)`,
    },
    keyCount: list === null ? null : list.length,
  };
}

export type Verdict =
  | 'YES_LIKELY'
  | 'PARTIAL'
  | 'NO_THIS_ROUTE'
  | 'NEGATIVE_CONTROL_OK'
  | 'NEGATIVE_CONTROL_UNEXPECTED'
  | 'INCONCLUSIVE';

export function decideVerdict(
  kind: AppIdKind,
  balance: StepResult,
  keys: StepResult,
): { verdict: Verdict; explanation: string } {
  const anyNetworkError = balance.status === null || keys.status === null;
  if (anyNetworkError) {
    return {
      verdict: 'INCONCLUSIVE',
      explanation: 'A Router call failed at the network level; re-run.',
    };
  }
  if (kind === 'own') {
    return balance.accepted || keys.accepted
      ? {
          verdict: 'NEGATIVE_CONTROL_UNEXPECTED',
          explanation:
            'The Router accepted a token from a non-0G Privy app. Report this; it contradicts the expected trust model.',
        }
      : {
          verdict: 'NEGATIVE_CONTROL_OK',
          explanation:
            "As expected, the Router rejects Privy tokens from an app other than 0G's. The real test needs 0G's app ID.",
        };
  }
  if (balance.accepted && keys.accepted) {
    return {
      verdict: 'YES_LIKELY',
      explanation:
        "A holder's 0G Privy session can read their balance and their API keys, so an app could (with consent) create a key funded by the holder's account. Final proof: a call whose usage record shows credit_used > 0.",
    };
  }
  if (balance.accepted || keys.accepted) {
    return {
      verdict: 'PARTIAL',
      explanation:
        'The session reaches part of the account. Spending credits from an app is not shown by this route alone.',
    };
  }
  const auth = [balance.status, keys.status].every((s) => s === 401 || s === 403);
  return auth
    ? {
        verdict: 'NO_THIS_ROUTE',
        explanation:
          "The Router rejects 0G's own Privy token for account access, so an app cannot reach holder credits this way. Holders would have to create an API key themselves on pc.0g.ai.",
      }
    : { verdict: 'INCONCLUSIVE', explanation: 'Unexpected statuses; see the steps.' };
}

/** Matches a JWT anywhere in a string. Used to keep tokens out of evidence. */
export const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

export interface EvidenceInput {
  readonly network: ZgNetwork;
  readonly appIdKind: AppIdKind;
  readonly origin: string;
  readonly privyUserLinked: boolean;
  readonly walletAddresses: readonly string[];
  readonly claims: JwtClaims | null;
  readonly configuredAppId: string;
  readonly balanceStep: StepResult;
  readonly balance: BalanceReading | null;
  readonly keysStep: StepResult;
  readonly keyCount: number | null;
  readonly now: Date;
}

export function buildEvidence(input: EvidenceInput): string {
  const verdict = decideVerdict(input.appIdKind, input.balanceStep, input.keysStep);
  const evidence = {
    kind: 'zg-holder-probe',
    recordedAt: input.now.toISOString(),
    network: input.network,
    appIdKind: input.appIdKind,
    origin: input.origin,
    privyLogin: input.privyUserLinked,
    walletAddresses: input.walletAddresses,
    token: {
      // The token itself is never recorded; only who issued it and for which app.
      issuer: input.claims?.iss ?? null,
      audienceMatchesConfiguredAppId:
        input.claims === null ? null : input.claims.aud === input.configuredAppId,
      expiresAt:
        input.claims === null || input.claims.exp === null
          ? null
          : new Date(input.claims.exp * 1000).toISOString(),
    },
    steps: [input.balanceStep, input.keysStep],
    balance: input.balance,
    apiKeyCount: input.keyCount,
    verdict: verdict.verdict,
    explanation: verdict.explanation,
  };
  const text = `${JSON.stringify(evidence, null, 2)}\n`;
  if (JWT_PATTERN.test(text)) throw new Error('refusing to build evidence: it contains a JWT');
  return text;
}

// ── the holder lane page (plan row 30, D-058) ─────────────────────────────

/**
 * The holder lane runs on localhost:3000: one of the three origins 0G's
 * Privy app ID accepts (3000, 3001, 5173), and free while the agent API uses
 * 3001 and the web app 5173.
 */
export const HOLDER_LANE_PORT = 3000;

/** neuron (18 decimals) → 0G, exact, trailing zeros trimmed. Pure. */
export function zgAmount(neuronText: string): string {
  if (!/^\d+$/.test(neuronText)) return neuronText;
  const n = BigInt(neuronText);
  const whole = n / 10n ** 18n;
  const frac = (n % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/**
 * Whether tasks may run on the holder's credits. Plan row 30 builds this only
 * if the probe (plan row 6) said yes; it has not, so the answer is fixed
 * until a YES_LIKELY run with 0G's app ID and a documented spending route.
 */
export const HOLDER_CREDIT_RUNS = {
  available: false,
  reason:
    "Not available. The probe has not shown that a Privy sign-in can spend a holder's 0G credits: the real test needs 0G's Privy app ID, which has not been shared, and 0G documents no way for an app to spend them. The agent pays for 0G with its own key.",
} as const;

export interface LaneResult {
  readonly balanceText: string;
  readonly accessText: string;
}

/** The result card's sentences, from the two read-only Router calls. Pure. */
export function laneResult(
  balance: BalanceReading | null,
  balanceStep: StepResult,
  keysStep: StepResult,
): LaneResult {
  return {
    balanceText:
      balance === null
        ? `Not readable: the 0G Router refused this sign-in (${balanceStep.detail}).`
        : `${zgAmount(balance.totalBalance)} 0G available (deposit ${zgAmount(balance.depositBalance)} 0G; credits, inferred: ${zgAmount(balance.inferredCreditPart)} 0G) for ${balance.address}.`,
    accessText: keysStep.accepted
      ? 'This sign-in can also list the account’s API keys (contents not shown or recorded).'
      : `This sign-in cannot list the account’s API keys (${keysStep.detail}).`,
  };
}
