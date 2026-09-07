import { z } from "zod";

import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

/**
 * Section 12.1: the UI always distinguishes remembered context, current
 * verified state, stale state, unknown state, and an unavailable source.
 *
 * `unknown` and `unavailable` are not synonyms and never stand in for each
 * other: nobody looked, versus the look failed. That distinction is the whole
 * reason this enum is not a boolean.
 */
export const SourceStatusSchema = z.enum(["current", "stale", "unavailable", "unknown"]);

/**
 * What an unavailable source means for anything that depended on it. A source
 * declares this rather than each caller guessing: a payment provider that
 * cannot be reached must not be read as "no charges", but a feed that cannot be
 * reached may reasonably be read as "nothing new".
 */
export const UnavailableSemanticsSchema = z.enum([
  /** Absence of an answer is not an answer. The default, and the safe one. */
  "unknown",
  /** The last observation stands until it expires. */
  "last_known",
]);

export const SourceRecordSchema = z
  .object({
    id: UuidSchema,
    sourceType: z.string().trim().min(1),
    externalId: z.string().trim().min(1),
    /** How long an observation stays `current`. The source's own policy. */
    freshnessSeconds: z.int().positive(),
    unavailableSemantics: UnavailableSemanticsSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const SourceObservationSchema = z
  .object({
    id: UuidSchema,
    sourceId: UuidSchema,
    status: SourceStatusSchema,
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    observedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
  })
  .strict();

/**
 * A source as the UI must show it: what Noctis remembered, what it last
 * observed, and whether those two disagree.
 *
 * `status` is normalized on read against the clock, never trusted from the row.
 * An observation written as `current` an hour ago is `stale` now, and a stored
 * word cannot know that.
 */
export const SourceStateSchema = z
  .object({
    source: SourceRecordSchema,
    status: SourceStatusSchema,
    /** The most recent observation, whatever its age. Absent means nobody has looked. */
    observed: SourceObservationSchema.optional(),
    /** The observation before it, when one exists — the "remembered" half. */
    remembered: SourceObservationSchema.optional(),
    /**
     * True when `remembered` and `observed` carry different payloads. Section
     * 12.1's "remembered/current conflict": the UI must show both, not silently
     * replace one with the other.
     */
    conflicted: z.boolean(),
    ageSeconds: z.number().nonnegative().optional(),
  })
  .strict();

export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export type UnavailableSemantics = z.infer<typeof UnavailableSemanticsSchema>;
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export type SourceObservation = z.infer<typeof SourceObservationSchema>;
export type SourceState = z.infer<typeof SourceStateSchema>;
