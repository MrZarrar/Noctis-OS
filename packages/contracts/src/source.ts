import { z } from "zod";

import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const SourceRecordSchema = z
  .object({
    id: UuidSchema,
    sourceType: z.string().trim().min(1),
    externalId: z.string().trim().min(1),
    freshnessSeconds: z.int().positive(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const SourceObservationSchema = z
  .object({
    id: UuidSchema,
    sourceId: UuidSchema,
    status: z.enum(["current", "stale", "unavailable", "unknown"]),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    observedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
  })
  .strict();

export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export type SourceObservation = z.infer<typeof SourceObservationSchema>;
