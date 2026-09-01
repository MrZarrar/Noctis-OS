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
    id: UuidSchema,
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    actorId: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    capability: z.string().trim().min(1),
    target: AuthorityTargetSchema,
    consequenceSummary: z.string().trim().min(1),
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
    decidedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const StandingPermissionSchema = z
  .object({
    id: UuidSchema,
    actorId: z.string().trim().min(1),
    capability: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    constraints: z.unknown(),
    grantedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
    revokedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export type Reversibility = z.infer<typeof ReversibilitySchema>;
export type AuthorityTarget = z.infer<typeof AuthorityTargetSchema>;
export type AuthorityOutcome = z.infer<typeof AuthorityOutcomeSchema>;
export type AuthorityRequest = z.infer<typeof AuthorityRequestSchema>;
export type AuthorityDecision = z.infer<typeof AuthorityDecisionSchema>;
export type StandingPermission = z.infer<typeof StandingPermissionSchema>;
