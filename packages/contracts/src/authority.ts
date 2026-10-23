import { z } from "zod";

import { OperationClassSchema } from "./enums.js";
import { IdempotencyKeySchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const ReversibilitySchema = z.enum(["reversible", "partially_reversible", "irreversible"]);

export const AuthorityTargetSchema = z
  .object({
    type: z.string().trim().min(1),
    id: z.string().trim().min(1),
    hostId: z.string().trim().min(1).optional(),
  })
  .strict();

export const AuthorityOutcomeSchema = z.enum([
  "allow",
  "deny",
  "require_confirmation",
  "require_typed_confirmation",
]);

export const AuthorityRequestSchema = z
  .object({
    taskId: UuidSchema.optional(),
    id: UuidSchema,
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    actorId: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    capability: z.string().trim().min(1),
    target: AuthorityTargetSchema,
    consequenceSummary: z.string().trim().min(1),
    /** The exact command or input the summary describes, kept so a person can check it. */
    consequenceDetail: z.string().max(4000).optional(),
    reversibility: ReversibilitySchema,
    estimatedCostGbp: z.number().nonnegative().optional(),
    idempotencyKey: IdempotencyKeySchema,
    requestedAt: UtcTimestampSchema,
  })
  .strict();

export const AuthorityDecisionSchema = z
  .object({
    requestId: UuidSchema,
    outcome: AuthorityOutcomeSchema,
    policyId: z.string().trim().min(1),
    reasonCodes: z.array(z.string().trim().min(1)),
    permissionId: UuidSchema.optional(),
    /**
     * Present exactly when the outcome is `require_typed_confirmation`. The
     * core derives it and stores it; a client renders it and must send it back
     * verbatim. It is never chosen by the caller, because a phrase the caller
     * picks is a phrase the caller can make easy to type by accident.
     */
    confirmationPhrase: z.string().trim().min(1).optional(),
    decidedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
  })
  .strict();

/**
 * Section 9.1: "Standing permissions are narrow, revocable, time-bound,
 * target-bound, and visible in Settings."
 *
 * `targetType` and `targetIds` are what make one target-bound; an empty
 * `targetIds` is not "any target" but a permission that matches nothing, so an
 * operator cannot widen a grant by deleting a line from it.
 */
export const AuthorityConstraintSchema = z
  .object({
    targetType: z.string().trim().min(1),
    targetIds: z.array(z.string().trim().min(1)).min(1).max(50),
    hostIds: z.array(z.string().trim().min(1)).max(20).optional(),
  })
  .strict();

export const StandingPermissionSchema = z
  .object({
    taskId: UuidSchema.optional(),
    id: UuidSchema,
    actorId: z.string().trim().min(1),
    capability: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    constraints: AuthorityConstraintSchema,
    grantedAt: UtcTimestampSchema,
    grantedBy: z.string().trim().min(1),
    expiresAt: UtcTimestampSchema.optional(),
    revokedAt: UtcTimestampSchema.optional(),
    revokedReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/**
 * The whole audit row for one consequential act: what was asked, what the
 * policy said, whether a human confirmed it, and whether it has already
 * happened. The Approval Surface renders this; nothing else is authoritative
 * about the state of an external consequence.
 */
export const ApprovalRecordSchema = z
  .object({
    taskId: UuidSchema.optional(),
    id: UuidSchema,
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    actorId: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    capability: z.string().trim().min(1),
    target: AuthorityTargetSchema,
    consequenceSummary: z.string().trim().min(1),
    /** The exact command or input the summary describes, kept so a person can check it. */
    consequenceDetail: z.string().max(4000).optional(),
    reversibility: ReversibilitySchema,
    estimatedCostGbp: z.number().nonnegative().optional(),
    outcome: AuthorityOutcomeSchema,
    policyId: z.string().trim().min(1),
    reasonCodes: z.array(z.string().trim().min(1)),
    permissionId: UuidSchema.optional(),
    confirmationPhrase: z.string().trim().min(1).optional(),
    requestedAt: UtcTimestampSchema,
    decidedAt: UtcTimestampSchema,
    /** Set once a human confirmed at the consequence boundary. Never by a model. */
    confirmedAt: UtcTimestampSchema.optional(),
    confirmedBy: z.string().trim().min(1).optional(),
    /** Set once, by the one execution that was allowed to happen. */
    executedAt: UtcTimestampSchema.optional(),
    /** What the external system said, kept so a status claim can be checked against it. */
    executionEvidence: z.unknown().optional(),
    /** Set when the human declined instead. A decline is a recorded fact, not an absence. */
    declinedAt: UtcTimestampSchema.optional(),
    declinedBy: z.string().trim().min(1).optional(),
    /** Present when the request came from a runtime ask mid-turn. */
    nodeJobId: UuidSchema.optional(),
    askId: UuidSchema.optional(),
  })
  .strict();

export type Reversibility = z.infer<typeof ReversibilitySchema>;
export type AuthorityTarget = z.infer<typeof AuthorityTargetSchema>;
export type AuthorityOutcome = z.infer<typeof AuthorityOutcomeSchema>;
export type AuthorityRequest = z.infer<typeof AuthorityRequestSchema>;
export type AuthorityDecision = z.infer<typeof AuthorityDecisionSchema>;
export type AuthorityConstraint = z.infer<typeof AuthorityConstraintSchema>;
export type StandingPermission = z.infer<typeof StandingPermissionSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
