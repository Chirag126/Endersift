/**
 * x402 facilitator discovery (`GET /supported`).
 *
 * Shape follows @x402/core's SupportedResponse:
 *   { kinds: [{ x402Version, scheme, network, extra? }], extensions, signers }
 * The Hedera `exact` scheme requires `extra.feePayer`: the facilitator account
 * that pays network fees and generates the transaction ID.
 */
import { getJson, isRecord, type JsonRequestOptions } from './http.ts';

export interface SupportedKind {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
  readonly extra: Record<string, unknown> | undefined;
}

export interface SupportedResponse {
  readonly kinds: readonly SupportedKind[];
  readonly extensions: readonly string[];
  readonly signers: Readonly<Record<string, readonly string[]>>;
}

export class FacilitatorResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FacilitatorResponseError';
  }
}

export function parseSupportedResponse(body: unknown): SupportedResponse {
  if (!isRecord(body)) throw new FacilitatorResponseError('/supported response is not an object');
  const kindsRaw = body['kinds'];
  if (!Array.isArray(kindsRaw)) throw new FacilitatorResponseError('/supported has no kinds array');

  const kinds = kindsRaw.map((k, i): SupportedKind => {
    if (!isRecord(k)) throw new FacilitatorResponseError(`kinds[${i}] is not an object`);
    const { x402Version, scheme, network, extra } = k;
    if (typeof x402Version !== 'number') {
      throw new FacilitatorResponseError(`kinds[${i}].x402Version is not a number`);
    }
    if (typeof scheme !== 'string')
      throw new FacilitatorResponseError(`kinds[${i}].scheme is not a string`);
    if (typeof network !== 'string') {
      throw new FacilitatorResponseError(`kinds[${i}].network is not a string`);
    }
    if (extra !== undefined && extra !== null && !isRecord(extra)) {
      throw new FacilitatorResponseError(`kinds[${i}].extra is not an object`);
    }
    return { x402Version, scheme, network, extra: isRecord(extra) ? extra : undefined };
  });

  const extensionsRaw = body['extensions'];
  const extensions = Array.isArray(extensionsRaw)
    ? extensionsRaw.filter((e): e is string => typeof e === 'string')
    : [];

  const signers: Record<string, string[]> = {};
  const signersRaw = body['signers'];
  if (isRecord(signersRaw)) {
    for (const [family, list] of Object.entries(signersRaw)) {
      if (Array.isArray(list))
        signers[family] = list.filter((s): s is string => typeof s === 'string');
    }
  }

  return { kinds, extensions, signers };
}

export type HederaKindResult =
  | { readonly ok: true; readonly kind: SupportedKind; readonly feePayer: string }
  | { readonly ok: false; readonly reason: string };

/** Find the `exact` scheme for a Hedera network and its fee payer, preferring the newest x402 version. */
export function findHederaExactKind(
  supported: SupportedResponse,
  network: string,
): HederaKindResult {
  const candidates = supported.kinds
    .filter((k) => k.scheme === 'exact' && k.network === network)
    .sort((a, b) => b.x402Version - a.x402Version);
  const kind = candidates[0];
  if (kind === undefined) {
    return { ok: false, reason: `no "exact" scheme advertised for ${network}` };
  }
  const feePayer = kind.extra?.['feePayer'];
  if (typeof feePayer !== 'string' || !/^0\.0\.\d+$/.test(feePayer)) {
    return { ok: false, reason: `"exact" on ${network} has no valid extra.feePayer` };
  }
  return { ok: true, kind, feePayer };
}

export interface ProbeResult {
  readonly url: string;
  readonly supported: SupportedResponse;
  readonly raw: string;
  readonly httpStatus: number;
}

export async function fetchSupported(
  baseUrl: string,
  options: JsonRequestOptions = {},
): Promise<ProbeResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/supported`;
  const { body, raw, status } = await getJson(url, options);
  return { url, supported: parseSupportedResponse(body), raw, httpStatus: status };
}

/**
 * Facilitators listed in the official Hedera docs (docs.hedera.com/solutions/ai/x402/facilitators,
 * read 2026-10-26), with the testnet fee payer each one advertises there. The probe compares the
 * live /supported answer with these values and reports any drift; the live answer always wins.
 */
export const DOCUMENTED_TESTNET_FACILITATORS = [
  { name: 'Blocky402', url: 'https://api.testnet.blocky402.com', feePayer: '0.0.7162784' },
  { name: 'Official x402', url: 'https://x402.org/facilitator', feePayer: '0.0.9185802' },
  { name: 'Ax402', url: 'https://testnet.facilitator.ax402.io', feePayer: '0.0.9839454' },
] as const;
