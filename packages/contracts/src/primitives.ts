import { z } from "zod";

/** UUIDv7 only. Phase 1 locked a monotonic sortable identifier. */
export const UuidSchema = z.uuidv7();

/** UTC ISO 8601. Local time exists only at presentation boundaries. */
export const UtcTimestampSchema = z.iso.datetime({ offset: true });

export const RevisionSchema = z.int().nonnegative();

export const IdempotencyKeySchema = z.string().trim().min(1).max(255);

export const SchemaVersionSchema = z.int().positive();

export type Uuid = z.infer<typeof UuidSchema>;
export type UtcTimestamp = z.infer<typeof UtcTimestampSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;
