-- apps/core/migrations/0009_attachments.sql
-- Slice 2, task 2.4 (decision 0.23): images and files in the prompt.
--
-- The bytes live here rather than on disk beside the database. One storage
-- location means one backup, one delete path, and no orphaned blobs when a row
-- goes -- and MAX_ATTACHMENT_BYTES (10 MB, contracts/attachment.ts) is what
-- bounds the growth. The upgrade path, when it is needed, is a content-addressed
-- file store keyed by `checksum`, which is already recorded for exactly that.
--
-- `artifact_id` is not optional and not an afterthought. Section 12.2: an
-- upload came from outside and nothing local holds it, so it is an
-- `external_reference` from the first moment it exists. A turn that saves it
-- under a granted root writes the `local_artifact` with this row's artifact as
-- its `derived_from_artifact_id`, and the lineage survives.
CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  -- sha256, hex. The node verifies its download against it: the bytes travel
  -- over a second connection from the one the job arrived on, and a truncated
  -- read that a runtime then reasons about is worse than a refused turn.
  checksum    TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id),
  created_at  TEXT NOT NULL
);

-- Uploading the same file twice is the same attachment. The idempotency key a
-- POST /attachments claims is derived from these two columns, so this index is
-- both the lookup and the statement that the pair is what identifies an upload.
CREATE UNIQUE INDEX idx_attachments_content ON attachments (checksum, filename);

-- Which attachments a turn was sent with. A join table rather than a JSON
-- column on the turn, because the question asked in practice runs the other way
-- -- "what did this file get used for" -- and a JSON array cannot answer it.
CREATE TABLE turn_attachments (
  turn_id       TEXT NOT NULL REFERENCES identity_turns (id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments (id),
  position      INTEGER NOT NULL,
  PRIMARY KEY (turn_id, attachment_id)
);

CREATE INDEX idx_turn_attachments_attachment ON turn_attachments (attachment_id);
