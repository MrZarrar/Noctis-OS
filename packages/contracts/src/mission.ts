import { z } from "zod";

import { MissionStatusSchema, OperationClassSchema } from "./enums.js";
import {
  RevisionSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";

export const MissionHostPolicySchema = z.enum(["core_only", "any_granted_host", "named_host"]);

export const MissionRecordSchema = z
  .object({
    id: UuidSchema,
    objectiveId: UuidSchema,
    title: z.string().trim().min(1),
    status: MissionStatusSchema,
    operationClass: OperationClassSchema,
    hostPolicy: MissionHostPolicySchema,
    hostId: z.string().trim().min(1).optional(),
    revision: RevisionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    startedAt: UtcTimestampSchema.optional(),
    completedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const MissionStepSchema = z
  .object({
    id: UuidSchema,
    missionId: UuidSchema,
    ordinal: z.int().nonnegative(),
    kind: z.enum(["deterministic", "model_backed"]),
    operationClass: OperationClassSchema,
    status: MissionStatusSchema,
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const MissionEvidenceSchema = z
  .object({
    id: UuidSchema,
    missionId: UuidSchema,
    stepId: UuidSchema.optional(),
    kind: z.enum(["command", "result", "verification"]),
    hostId: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    observedAt: UtcTimestampSchema,
  })
  .strict();

export type MissionHostPolicy = z.infer<typeof MissionHostPolicySchema>;
export type MissionRecord = z.infer<typeof MissionRecordSchema>;
export type MissionStep = z.infer<typeof MissionStepSchema>;
export type MissionEvidence = z.infer<typeof MissionEvidenceSchema>;
