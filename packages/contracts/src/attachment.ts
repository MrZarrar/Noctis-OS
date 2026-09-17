import { z } from "zod";

import { UtcTimestampSchema, UuidSchema } from "./primitives.js";

/**
 * A file the owner put in a prompt (decision 0.23).
 *
 * The bytes belong to the core, not to the node: a node downloads a copy into
 * one turn's temp directory with its own credential and throws it away when the
 * turn ends. That is what keeps an attachment a thing the owner uploaded once
 * rather than a file scattered across every machine that has ever run a turn.
 *
 * Every attachment is also an `external_reference` artifact the moment it is
 * uploaded — it came from outside and nothing local holds it yet (Section 12.2).
 * A turn that saves it under a granted root produces the `local_artifact`, with
 * the reference as its lineage.
 */

/**
 * The content types a prompt may carry.
 *
 * An allowlist rather than a denylist, and deliberately short: these are the
 * types a model can actually do something with. Anything not named here is
 * refused at upload, so a file the core cannot describe never reaches a node.
 *
 * No `image/svg+xml`, though it is an image: SVG is a document that can carry
 * script, and the core serves attachment bytes back to the node over HTTP.
 * No archives — a zip is a filesystem, and the size cap would be measuring the
 * wrong number.
 */
export const ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
] as const;

/**
 * 10 MB, and it is a cap on each file rather than on a prompt's worth of them.
 *
 * ponytail: the bytes live in a SQLite BLOB column beside the row, so this
 * number is also how fast `core.db` can grow. That is the right trade at one
 * owner's volume — no second storage location to configure, back up, or leave
 * orphaned when a row is deleted — and the upgrade path is a content-addressed
 * file store beside the database keyed by the checksum already recorded here.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const AttachmentMediaTypeSchema = z.enum(ATTACHMENT_MEDIA_TYPES);

/**
 * Filenames are the node's temp-file names, so this is a containment boundary.
 * No separators, no `..`, no leading dot, no NUL — a name that survives this is
 * a name that cannot walk out of the directory it is written into.
 */
export const AttachmentFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // A control character in a filename is never a filename; rejecting the whole
  // `\p{Cc}` class rather than NUL alone keeps the rule readable in source,
  // where a literal control byte would be invisible to a reviewer and a linter.
  .refine((name) => !name.includes("/") && !name.includes("\\") && !/\p{Cc}/u.test(name), {
    message: "a filename may not contain a path separator or a control character",
  })
  .refine((name) => name !== "." && name !== ".." && !name.startsWith("."), {
    message: "a filename may not start with a dot",
  });

export const AttachmentRecordSchema = z
  .object({
    id: UuidSchema,
    filename: AttachmentFilenameSchema,
    mediaType: AttachmentMediaTypeSchema,
    sizeBytes: z.int().positive().max(MAX_ATTACHMENT_BYTES),
    /** sha256 of the bytes, hex. The node verifies its download against it. */
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    /** The `external_reference` this upload created. */
    artifactId: UuidSchema,
    createdAt: UtcTimestampSchema,
  })
  .strict();

/** What a turn payload carries: enough for the node to fetch and name each file. */
export const AttachmentRefSchema = z
  .object({
    id: UuidSchema,
    filename: AttachmentFilenameSchema,
    mediaType: AttachmentMediaTypeSchema,
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type AttachmentMediaType = z.infer<typeof AttachmentMediaTypeSchema>;
export type AttachmentRecord = z.infer<typeof AttachmentRecordSchema>;
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
