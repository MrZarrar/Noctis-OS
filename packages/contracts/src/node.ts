import { z } from "zod";

import { NodeJobStatusSchema, OperationClassSchema } from "./enums.js";
import {
  IdempotencyKeySchema,
  RevisionSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";

export const NodeDescriptorSchema = z
  .object({
    id: UuidSchema,
    hostId: z.string().trim().min(1),
    status: z.enum(["pending", "paired", "online", "offline", "revoked"]),
    fingerprint: z.string().trim().min(1),
    agentVersion: z.string().trim().min(1),
    lastSeenAt: UtcTimestampSchema.optional(),
    revokedAt: UtcTimestampSchema.optional(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const CapabilityGrantSchema = z
  .object({
    id: UuidSchema,
    nodeId: UuidSchema,
    capability: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    constraintsVersion: SchemaVersionSchema,
    constraints: z.unknown(),
    grantedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
    revokedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const NodeJobSchema = z
  .object({
    id: UuidSchema,
    missionId: UuidSchema.optional(),
    nodeId: UuidSchema.optional(),
    capability: z.string().trim().min(1),
    status: NodeJobStatusSchema,
    idempotencyKey: IdempotencyKeySchema,
    leaseExpiresAt: UtcTimestampSchema.optional(),
    attempts: z.int().nonnegative(),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    revision: RevisionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export type NodeDescriptor = z.infer<typeof NodeDescriptorSchema>;
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;
export type NodeJob = z.infer<typeof NodeJobSchema>;
