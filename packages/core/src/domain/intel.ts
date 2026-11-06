/**
 * Normalised threat-intel payloads served by the paid providers (plan row 15).
 * One shape for every source (CISA KEV, NVD, OSV), so the agent compares and
 * merges items without per-source code. Providers validate before sending;
 * the agent validates again on receipt (provider responses are untrusted).
 * Every string is length-capped; unknown keys are rejected.
 */
import { z } from 'zod';
import { HttpsUrl, IsoTimestamp, Slug } from './primitives.ts';

/** Calendar date YYYY-MM-DD (UTC), checked for validity. */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((v) => new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v, 'invalid date');

export const IntelSeverity = z.enum(['critical', 'high', 'medium', 'low', 'none', 'unknown']);
export type IntelSeverity = z.infer<typeof IntelSeverity>;

/** CVE-…, GHSA-…, PYSEC-…, GO-…, RUSTSEC-… and similar advisory identifiers. */
export const AdvisoryId = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{2,63}$/, 'not an advisory id');

export const IntelItem = z
  .object({
    id: AdvisoryId,
    aliases: z.array(AdvisoryId).max(32),
    title: z.string().max(300),
    summary: z.string().max(4000),
    severity: IntelSeverity,
    cvss: z
      .object({
        version: z.string().regex(/^[234](\.[01])?$/),
        score: z.number().min(0).max(10).nullable(),
        vector: z.string().max(200).nullable(),
      })
      .strict()
      .nullable(),
    published: IsoDate.nullable(),
    modified: IsoDate.nullable(),
    cwes: z.array(z.string().regex(/^CWE-\d{1,6}$/)).max(16),
    vendor: z.string().max(120).nullable(),
    product: z.string().max(120).nullable(),
    /** CISA KEV only: the catalogue entry. */
    exploited: z
      .object({
        dateAdded: IsoDate,
        dueDate: IsoDate.nullable(),
        ransomware: z.enum(['known', 'unknown']),
        requiredAction: z.string().max(1000),
      })
      .strict()
      .nullable(),
    /** OSV: affected packages and version ranges. */
    affected: z
      .array(
        z
          .object({
            ecosystem: z.string().max(40),
            package: z.string().max(214),
            ranges: z
              .array(
                z
                  .object({
                    introduced: z.string().max(64).nullable(),
                    fixed: z.string().max(64).nullable(),
                  })
                  .strict(),
              )
              .max(16),
          })
          .strict(),
      )
      .max(20),
    references: z.array(HttpsUrl).max(10),
  })
  .strict();
export type IntelItem = z.infer<typeof IntelItem>;

export const IntelSource = z
  .object({
    name: z.string().max(120),
    url: HttpsUrl,
    license: z.string().max(200),
    /** When the provider last fetched the upstream data (it may be cached). */
    fetchedAt: IsoTimestamp,
    /** Upstream version or release marker, when the source publishes one. */
    version: z.string().max(64).nullable(),
  })
  .strict();

export const IntelResponse = z
  .object({
    provider: Slug,
    operation: Slug,
    source: IntelSource,
    /** The validated query, echoed back. */
    query: z.record(z.string().max(40), z.string().max(400)),
    count: z.number().int().nonnegative(),
    /** More items matched than were returned (limit or upstream paging). */
    truncated: z.boolean(),
    /** Requested identifiers the source does not know. */
    notFound: z.array(z.string().max(64)).max(100),
    items: z.array(IntelItem).max(100),
    servedAt: IsoTimestamp,
  })
  .strict()
  .refine((r) => r.count === r.items.length, 'count must equal items.length');
export type IntelResponse = z.infer<typeof IntelResponse>;

/** Query parameter names (provider catalogs and planned purchases). */
export const ParamName = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'not a parameter name');

/** One operation in a provider's free description (`GET <ENS endpoint>`). Untrusted input. */
export const CatalogOperation = z
  .object({
    name: Slug,
    method: z.literal('GET'),
    path: z.string().regex(/^\/[A-Za-z0-9._~/-]{1,200}$/, 'not a plain absolute path'),
    description: z.string().max(300),
    params: z
      .record(ParamName, z.string().max(200))
      .refine((p) => Object.keys(p).length <= 8, 'at most 8 parameters'),
    payment: z
      .object({
        scheme: z.string().max(20),
        network: z.string().max(40),
        asset: z.string().max(40),
        amount: z.string().regex(/^\d{1,30}$/),
        payTo: z.string().max(40),
      })
      .strict(),
  })
  .strict();
export type CatalogOperation = z.infer<typeof CatalogOperation>;

/**
 * A provider's free description of what it sells (plan row 24, D-046). The
 * orchestrator keeps an operation only if it agrees with the ENS records.
 */
export const ProviderCatalog = z
  .object({
    provider: Slug,
    operations: z.array(CatalogOperation).min(1).max(8),
  })
  .strict();
export type ProviderCatalog = z.infer<typeof ProviderCatalog>;
