import { z } from "zod";
import { IdempotencyKeySchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";
import { ContentHashSchema } from "./vault.js";

export const PalaceKindSchema = z.enum(["thought", "book", "quote", "art", "letter"]);
export const PalaceRoomSchema = z.enum(["library", "gallery"]);
export const PalaceConnectionSchema = z
  .object({
    relationship: z.enum(["related", "inspired_by", "responds_to"]),
    targetId: UuidSchema,
    reason: z.string().max(1000).optional(),
  })
  .strict();

export const PalaceContentsSchema = z
  .object({
    kind: PalaceKindSchema,
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(100_000),
    tags: z.array(z.string().min(1).max(100)).max(50),
    sensitive: z.boolean(),
    archived: z.boolean(),
    bookId: UuidSchema.optional(),
    location: z.string().max(1000).optional(),
    author: z.string().max(200).optional(),
    edition: z.string().max(500).optional(),
    readingStatus: z.enum(["planned", "reading", "paused", "finished"]).optional(),
    readingLane: z.string().max(100).optional(),
    connections: z.array(PalaceConnectionSchema).max(200),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.kind === "quote" && entry.bookId === undefined)
      context.addIssue({ code: "custom", path: ["bookId"], message: "A quote needs a book" });
    if (entry.kind === "book" && !entry.title?.trim())
      context.addIssue({ code: "custom", path: ["title"], message: "A book needs a title" });
    if (
      entry.kind !== "book" &&
      [entry.author, entry.edition, entry.readingStatus, entry.readingLane].some(
        (value) => value !== undefined,
      )
    )
      context.addIssue({ code: "custom", message: "Book details belong on a book" });
  });

export const PalaceEntrySchema = PalaceContentsSchema.extend({
  id: UuidSchema,
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
  contentHash: ContentHashSchema,
});
const CommandBase = { idempotencyKey: IdempotencyKeySchema, entryId: UuidSchema };
export const SavePalaceCommandSchema = z
  .object({
    ...CommandBase,
    contents: PalaceContentsSchema,
    expectedHash: ContentHashSchema.optional(),
  })
  .strict();
export const ArchivePalaceCommandSchema = z
  .object({ ...CommandBase, expectedHash: ContentHashSchema })
  .strict();
export const RestorePalaceCommandSchema = ArchivePalaceCommandSchema;
export const PalaceListQuerySchema = z
  .object({
    query: z.string().max(500).optional(),
    kind: PalaceKindSchema.optional(),
    bookId: UuidSchema.optional(),
    archived: z.enum(["false", "true", "all"]).default("false"),
    room: PalaceRoomSchema.optional(),
    cursor: UuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export const PalaceListSchema = z
  .object({
    entries: z.array(PalaceEntrySchema).max(200),
    nextCursor: UuidSchema.optional(),
  })
  .strict();

export const PalaceReceiptSchema = z
  .object({
    entryId: UuidSchema,
    contentHash: ContentHashSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    indexStatus: z.enum(["current", "pending"]),
  })
  .strict();
export type PalaceReceipt = z.infer<typeof PalaceReceiptSchema>;

export type PalaceKind = z.infer<typeof PalaceKindSchema>;
export type PalaceRoom = z.infer<typeof PalaceRoomSchema>;
export type PalaceConnection = z.infer<typeof PalaceConnectionSchema>;
export type PalaceContents = z.infer<typeof PalaceContentsSchema>;
export type PalaceEntry = z.infer<typeof PalaceEntrySchema>;
export type PalaceListQuery = z.infer<typeof PalaceListQuerySchema>;
export type PalaceList = z.infer<typeof PalaceListSchema>;
export type SavePalaceCommand = z.infer<typeof SavePalaceCommandSchema>;
export type ArchivePalaceCommand = z.infer<typeof ArchivePalaceCommandSchema>;
export type RestorePalaceCommand = z.infer<typeof RestorePalaceCommandSchema>;
