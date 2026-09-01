import { z } from "zod";

import { NoirCaseStatusSchema } from "./enums.js";
import { RevisionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const NoirCaseSchema = z
  .object({
    id: UuidSchema,
    objectiveId: UuidSchema,
    question: z.string().trim().min(1),
    status: NoirCaseStatusSchema,
    synthesis: z.string().optional(),
    revision: RevisionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const HypothesisSchema = z
  .object({
    id: UuidSchema,
    caseId: UuidSchema,
    statement: z.string().trim().min(1),
    rank: z.int().nonnegative(),
    status: z.enum(["open", "supported", "refuted", "withdrawn"]),
    confidenceRationale: z.string().trim().min(1),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const EvidenceItemSchema = z
  .object({
    id: UuidSchema,
    caseId: UuidSchema,
    hypothesisId: UuidSchema.optional(),
    sourceId: UuidSchema.optional(),
    artifactId: UuidSchema.optional(),
    stance: z.enum(["supports", "refutes", "neutral"]),
    verification: z.enum(["unverified", "verified", "failed"]),
    summary: z.string().trim().min(1),
    observedAt: UtcTimestampSchema,
  })
  .strict();

export const FalsifierSchema = z
  .object({
    id: UuidSchema,
    caseId: UuidSchema,
    hypothesisId: UuidSchema,
    check: z.string().trim().min(1),
    result: z.enum(["pending", "passed", "failed", "inconclusive"]),
    createdAt: UtcTimestampSchema,
    resolvedAt: UtcTimestampSchema.optional(),
  })
  .strict();

/** Uncertainty is retained, never silently resolved into false confidence. */
export const UncertaintySchema = z
  .object({
    id: UuidSchema,
    caseId: UuidSchema,
    statement: z.string().trim().min(1),
    reason: z.enum(["missing_evidence", "conflicting_evidence", "stale_source", "out_of_scope"]),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export type NoirCase = z.infer<typeof NoirCaseSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type Falsifier = z.infer<typeof FalsifierSchema>;
export type Uncertainty = z.infer<typeof UncertaintySchema>;
