/**
 * Model-produced analysis (plan rows 17, 22+): what 0G inference must return
 * for the agent to act on it. Every model output is untrusted and parsed
 * against these schemas; nothing here is ever fed back to the firewall as an
 * instruction.
 */
import { z } from 'zod';
import { AdvisoryId, ParamName } from './intel.ts';
import { EnsName, Slug } from './primitives.ts';

export const TriagePriority = z.enum(['p1', 'p2', 'p3']);

/** One prioritised assessment of an advisory already fetched from a paid provider. */
export const TriageAssessment = z
  .object({
    id: AdvisoryId,
    priority: TriagePriority,
    /** The model's reading of whether the input shows exploitation in the wild. */
    exploitedInWild: z.boolean(),
    rationale: z.string().min(1).max(400),
  })
  .strict();
export type TriageAssessment = z.infer<typeof TriageAssessment>;

/** Prioritised assessment of advisories (fixed checks: at least one assessment). */
export const TriageResult = z
  .object({
    assessments: z.array(TriageAssessment).min(1).max(20),
    summary: z.string().min(1).max(600),
  })
  .strict();
export type TriageResult = z.infer<typeof TriageResult>;

/**
 * The orchestrator's analysis of purchased data against a watchlist (D-050).
 * Unlike TriageResult, an empty list is valid: "none of these affect the
 * stack" is a correct answer, and refusing it (seen live, Phase 25) turned an
 * honest model answer into a failed run.
 */
export const StackAnalysis = z
  .object({
    assessments: z.array(TriageAssessment).max(20),
    summary: z.string().min(1).max(600),
  })
  .strict();
export type StackAnalysis = z.infer<typeof StackAnalysis>;

/**
 * One purchase the planning model proposes (plan row 24). UNTRUSTED: the
 * orchestrator builds the URL itself from the discovered catalog, and the
 * firewall decides; nothing here can raise a budget or name a payee.
 */
export const PlannedPurchase = z
  .object({
    provider: EnsName,
    capability: Slug,
    operation: Slug,
    params: z
      .record(ParamName, z.string().min(1).max(200))
      .refine((p) => Object.keys(p).length <= 6, 'at most 6 parameters'),
    rationale: z.string().min(1).max(400),
  })
  .strict();
export type PlannedPurchase = z.infer<typeof PlannedPurchase>;

export const PurchasePlan = z
  .object({
    purchases: z.array(PlannedPurchase).max(8),
    /** One sentence: what this run looks for. */
    focus: z.string().min(1).max(400),
  })
  .strict();
export type PurchasePlan = z.infer<typeof PurchasePlan>;
