import { z } from "zod";

import { UtcTimestampSchema, UuidSchema } from "./primitives.js";

/**
 * Section 7: "explicit current/stale/unknown/unavailable status when remembered
 * claims concern live external state". These four are the only words the system
 * may use about a remembered claim, and they are never inferred from each other
 * — `unknown` means nobody looked, `unavailable` means the look failed.
 */
export const VaultFreshnessSchema = z.enum(["current", "stale", "unknown", "unavailable"]);

/** A byte range in a note's raw Markdown. The unit of provenance. */
export const VaultSpanSchema = z
  .object({ start: z.int().nonnegative(), end: z.int().nonnegative() })
  .strict()
  .refine((span) => span.end >= span.start, {
    message: "a span cannot end before it starts",
    path: ["end"],
  });

/** SHA-256 of the note's raw bytes, lowercase hex. */
export const ContentHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A Markdown note as indexed. The file on disk is the authority; this row is a
 * disposable pointer to it, which is why it stores a hash and never the body.
 */
export const VaultItemSchema = z
  .object({
    id: UuidSchema,
    /** Vault-relative, POSIX separators, never absolute — a row cannot name a path outside the root. */
    path: z
      .string()
      .trim()
      .min(1)
      .regex(/^[^/\\][^\\]*$/, "must be a vault-relative POSIX path"),
    title: z.string().trim().min(1),
    contentHash: ContentHashSchema,
    byteLength: z.int().nonnegative(),
    modifiedAt: UtcTimestampSchema,
    indexedAt: UtcTimestampSchema,
  })
  .strict();

/**
 * The PARA folder a note lives in decides its type. Derived from the path and
 * nothing else, so indexing is deterministic and needs no model.
 */
export const VaultEntityTypeSchema = z.enum([
  "capture",
  "project",
  "person",
  "reference",
  "daily",
  "agent",
  "note",
]);

/**
 * A subject the Vault knows about, identified by a normalized key.
 *
 * Entities are derived, items are raw: a note produces an entity, and so does a
 * wikilink to a note that does not exist yet. Keeping both in one table is what
 * lets a link to a future note resolve the moment that note appears, without
 * rewriting anything.
 */
export const VaultEntitySchema = z
  .object({
    id: UuidSchema,
    key: z.string().trim().min(1),
    name: z.string().trim().min(1),
    type: VaultEntityTypeSchema,
    /** The note this entity is, when one exists. Absent means mentioned but unwritten. */
    itemId: UuidSchema.optional(),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export const VaultEdgeTypeSchema = z.enum(["link", "frontmatter"]);

export const VaultEdgeSchema = z
  .object({
    id: UuidSchema,
    srcEntityId: UuidSchema,
    dstEntityId: UuidSchema,
    type: VaultEdgeTypeSchema,
    /** The note the relationship was read out of. Every edge has one. */
    sourceItemId: UuidSchema,
    confidence: z.number().min(0).max(1),
    /** Whether the target is a real note yet. */
    lifecycle: z.enum(["resolved", "unresolved"]),
    createdAt: UtcTimestampSchema,
  })
  .strict();

/**
 * Where a derived fact came from: a note, a byte span in it, and the hash the
 * note had when the fact was derived.
 *
 * The hash is what makes "changed notes invalidate only affected derivations"
 * checkable rather than assumed — a mention whose recorded hash no longer
 * matches its item is stale, and nothing else is.
 */
export const VaultMentionSchema = z
  .object({
    id: UuidSchema,
    entityId: UuidSchema,
    itemId: UuidSchema,
    edgeId: UuidSchema.optional(),
    span: VaultSpanSchema,
    quote: z.string(),
    contentHash: ContentHashSchema,
    createdAt: UtcTimestampSchema,
  })
  .strict();

/**
 * A node's persisted place in the sphere.
 *
 * Coordinates are stored rather than recomputed on every render because
 * Section 7 requires them to be stable: a note keeps its position across
 * reindexes, restarts, and the arrival of unrelated notes.
 */
export const VaultLayoutSchema = z
  .object({
    entityId: UuidSchema,
    /** Bumped when the layout algorithm changes, so old coordinates can be recognised. */
    version: z.int().positive(),
    x: z.number(),
    y: z.number(),
    z: z.number(),
    settledAt: UtcTimestampSchema,
  })
  .strict();

export const VaultRecallEvidenceSchema = z
  .object({
    itemId: UuidSchema,
    entityId: UuidSchema,
    path: z.string().trim().min(1),
    span: VaultSpanSchema,
    quote: z.string(),
    freshness: VaultFreshnessSchema,
  })
  .strict();

/**
 * What a recall returned and why. Section 7: "focused recall opens only the
 * relevant subgraph, not a miniature full Vault".
 */
export const VaultRecallSchema = z
  .object({
    id: UuidSchema,
    objectiveId: UuidSchema.optional(),
    query: z.string().trim().min(1),
    /** The focused subgraph: exactly the entities the evidence touches. */
    entityIds: z.array(UuidSchema),
    evidence: z.array(VaultRecallEvidenceSchema),
    freshness: VaultFreshnessSchema,
    recordedAt: UtcTimestampSchema,
  })
  .strict();

export type VaultFreshness = z.infer<typeof VaultFreshnessSchema>;
export type VaultSpan = z.infer<typeof VaultSpanSchema>;
export type VaultItem = z.infer<typeof VaultItemSchema>;
export type VaultEntityType = z.infer<typeof VaultEntityTypeSchema>;
export type VaultEntity = z.infer<typeof VaultEntitySchema>;
export type VaultEdgeType = z.infer<typeof VaultEdgeTypeSchema>;
export type VaultEdge = z.infer<typeof VaultEdgeSchema>;
export type VaultMention = z.infer<typeof VaultMentionSchema>;
export type VaultLayout = z.infer<typeof VaultLayoutSchema>;
export type VaultRecallEvidence = z.infer<typeof VaultRecallEvidenceSchema>;
export type VaultRecall = z.infer<typeof VaultRecallSchema>;
