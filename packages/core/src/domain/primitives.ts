/**
 * Shared value schemas. Every external or persisted value is parsed through
 * one of these before the application trusts it.
 *
 * Money is never a JS number: atomic amounts (tinybars, neuron, MockUSDC
 * units) are canonical decimal strings, converted to bigint where arithmetic
 * is needed.
 */
import { z } from 'zod';

/** Canonical non-negative integer string: no sign, no leading zeros, no exponent. */
export const AtomicAmount = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/, 'must be a canonical non-negative integer string');
export const PositiveAtomicAmount = AtomicAmount.refine(
  (v) => v !== '0',
  'must be greater than zero',
);

export const HederaAccountId = z
  .string()
  .regex(/^0\.0\.\d{1,19}$/, 'must be a Hedera account ID like 0.0.12345');
/** SDK form 0.0.N@seconds.nanos. */
export const HederaTransactionId = z
  .string()
  .regex(/^0\.0\.\d+@\d+\.\d{9}$/, 'must look like 0.0.N@seconds.nanos');
export const HederaNetwork = z.enum(['hedera:testnet', 'hedera:mainnet']);

export const EvmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte 0x address');
export const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'must be 32 bytes of lowercase hex');

/** A normalised ENS name ending in .eth (normalisation itself is done by viem in packages/ens). */
export const EnsName = z
  .string()
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+eth$/, 'must be a lowercase .eth name');

export const HttpsUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && u.username === '' && u.password === '';
    } catch {
      return false;
    }
  }, 'must be an https URL without credentials');

/** Loopback hosts as URL#hostname reports them. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for an http URL whose host is loopback (127.0.0.1, localhost, ::1). */
export function isLoopbackHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * A provider endpoint: https, or http on a loopback host (local development
 * before deployment, D-035). Whether a loopback endpoint is acceptable is
 * decided by the caller (discovery's `allowLocalHttp`); this schema only
 * rules out everything else (public http, credentials, other schemes).
 */
export const ProviderEndpoint = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      if (u.username !== '' || u.password !== '') return false;
      return u.protocol === 'https:' || isLoopbackHttpUrl(v);
    } catch {
      return false;
    }
  }, 'must be an https URL (or http on a loopback host) without credentials');

/** ISO-8601 UTC timestamp with milliseconds, as produced by Date#toISOString. */
export const IsoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'must be an ISO-8601 UTC timestamp')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be a real date');

export const Uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'must be a lowercase UUID',
  );

/** Lowercase slug used for provider labels and capability names. */
export const Slug = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'must be a lowercase slug');

export const ZgNetwork = z.enum(['mainnet', 'testnet']);
export const ChainName = z.enum(['sepolia', 'mainnet']);
