import { createHash } from "node:crypto";

import type { AttachmentRecord, AttachmentRef } from "@noctis/contracts";
import {
  AttachmentFilenameSchema,
  AttachmentMediaTypeSchema,
  AttachmentRecordSchema,
  MAX_ATTACHMENT_BYTES,
} from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import { insertArtifact } from "../artifacts/service.js";
import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";

/**
 * Files in a prompt (task 2.4, decision 0.23).
 *
 * The core holds the bytes and hands out copies. A node fetches one over
 * `GET /node/attachments/:id` with its own credential, writes it into the
 * turn's temp directory, and deletes it when the turn ends — so an attachment
 * is something the owner uploaded once, not a file that accumulates on every
 * machine that has ever run a turn for them.
 *
 * Every upload is also an `external_reference` artifact from the moment it
 * exists (Section 12.2): it came from outside and nothing local holds it. The
 * `local_artifact` appears when a turn saves it under a granted root.
 */

type AttachmentRow = {
  id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  checksum: string;
  artifact_id: string;
  created_at: string;
};

const COLUMNS = `id, filename, media_type, size_bytes, checksum, artifact_id, created_at`;

function toRecord(row: AttachmentRow): AttachmentRecord {
  return AttachmentRecordSchema.parse({
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    artifactId: row.artifact_id,
    createdAt: row.created_at,
  });
}

export function getAttachment(db: NoctisDatabase, id: string): AttachmentRecord | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`).get(id) as
    AttachmentRow | undefined;

  return row === undefined ? undefined : toRecord(row);
}

/**
 * The bytes, for the node realm and nothing else.
 *
 * Separate from `getAttachment` on purpose: every other read of an attachment
 * wants its metadata, and a function that always loaded a 10 MB blob to answer
 * "what is this file called" would be paid for on every list.
 */
export function readAttachmentBytes(db: NoctisDatabase, id: string): Uint8Array | undefined {
  const row = db.prepare("SELECT bytes FROM attachments WHERE id = ?").get(id) as
    { bytes: Uint8Array } | undefined;

  return row?.bytes;
}

/** What a turn payload carries. Enough for the node to fetch, name and verify each file. */
export function attachmentRefs(db: NoctisDatabase, ids: readonly string[]): AttachmentRef[] {
  return ids.flatMap((id) => {
    const record = getAttachment(db, id);

    return record === undefined
      ? []
      : [
          {
            id: record.id,
            filename: record.filename,
            mediaType: record.mediaType,
            checksum: record.checksum,
          },
        ];
  });
}

export function linkTurnAttachments(
  tx: NoctisDatabase,
  turnId: string,
  attachmentIds: readonly string[],
): void {
  const statement = tx.prepare(
    "INSERT INTO turn_attachments (turn_id, attachment_id, position) VALUES (?, ?, ?)",
  );

  attachmentIds.forEach((attachmentId, position) => {
    statement.run(turnId, attachmentId, position);
  });
}

export interface UploadAttachment {
  filename: string;
  mediaType: string;
  bytes: Uint8Array;
}

/**
 * Records an upload, or refuses it.
 *
 * The idempotency key is derived from the content rather than supplied by the
 * caller, because a file upload has no JSON body to carry one: the same bytes
 * under the same name are the same attachment, and a phone that retries a
 * flaky upload gets the row it already made instead of a second copy. The
 * unique index on `(checksum, filename)` is what settles the concurrent case;
 * this read alone would not.
 */
export function uploadAttachment(
  kernel: Kernel,
  context: CommandContext,
  upload: UploadAttachment,
): Result<AttachmentRecord> {
  const filename = AttachmentFilenameSchema.safeParse(upload.filename);

  if (!filename.success) {
    return conflict({
      kind: "unavailable",
      entity: "attachment",
      reason: "invalid_filename",
    });
  }

  const mediaType = AttachmentMediaTypeSchema.safeParse(upload.mediaType);

  if (!mediaType.success) {
    return conflict({
      kind: "unavailable",
      entity: "attachment",
      reason: "unsupported_media_type",
    });
  }

  if (upload.bytes.length === 0 || upload.bytes.length > MAX_ATTACHMENT_BYTES) {
    return conflict({ kind: "unavailable", entity: "attachment", reason: "invalid_size" });
  }

  const checksum = createHash("sha256").update(upload.bytes).digest("hex");
  const id = kernel.ids.nextId();
  const artifactId = kernel.ids.nextId();
  const now = new Date(kernel.clock.now()).toISOString();

  const outcome = runCommand<AttachmentRecord>(
    kernel,
    { scope: "attachment.upload", key: `${checksum}:${filename.data}`, resultId: id },
    (tx) => {
      insertArtifact(tx, {
        id: artifactId,
        kind: "external_reference",
        title: filename.data,
        // Not a path and not a URL anyone can dereference without the core.
        // That is the point: the reference names the upload, and the bytes are
        // reachable only through a realm that checks a credential.
        uri: `noctis-attachment:${id}`,
        mediaType: mediaType.data,
        provenanceVersion: 1,
        provenance: {
          kind: "prompt_attachment",
          filename: filename.data,
          sizeBytes: upload.bytes.length,
          checksum,
          uploadedBy: context.actorId,
        },
        createdAt: now,
      });

      tx.prepare(
        `INSERT INTO attachments
           (id, filename, media_type, size_bytes, checksum, bytes, artifact_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        filename.data,
        mediaType.data,
        upload.bytes.length,
        checksum,
        upload.bytes,
        artifactId,
        now,
      );

      const record = getAttachment(tx, id);

      if (record === undefined) {
        throw new Error(`Attachment ${id} vanished mid-transaction`);
      }

      return ok({
        value: record,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "artifact",
            streamId: artifactId,
            type: "artifact.recorded.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: {
              artifactId,
              kind: "external_reference",
              title: filename.data,
            },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );

  // The same bytes under the same name claim the same key, so a re-upload lands
  // here rather than in the mutation. It answers with the row that already
  // exists: a phone retrying a flaky upload wants the attachment id, not a 409
  // it has no way to act on.
  if (!outcome.ok && outcome.conflict.kind === "idempotent_replay") {
    const existing = getAttachment(kernel.db, outcome.conflict.existingId);

    if (existing !== undefined) {
      return ok(existing);
    }
  }

  return outcome;
}
