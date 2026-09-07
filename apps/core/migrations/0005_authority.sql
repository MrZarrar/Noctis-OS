-- apps/core/migrations/0005_authority.sql
-- Phase 8: the consequence boundary, source freshness, and artifact lineage.
--
-- Migration 0001 created `approvals`, `standing_permissions`, `artifacts`,
-- `sources`, and `source_observations` as Section 4.1 lists them. Phase 2 filled
-- in the request-and-decision half of `approvals`. What was missing is
-- everything after the decision: whether a human confirmed at the exact
-- consequence boundary, and whether the consequence has already happened.
--
-- Those two columns are what make Section 9.1 enforceable rather than
-- descriptive. `executed_at` in particular is the single fact that stops a
-- duplicate submit from repeating an external consequence: it is written once,
-- inside the same transaction that authorises the execution, and every later
-- attempt reads it and refuses.

ALTER TABLE approvals ADD COLUMN confirmation_phrase TEXT;
ALTER TABLE approvals ADD COLUMN confirmed_at TEXT;
ALTER TABLE approvals ADD COLUMN confirmed_by TEXT;
ALTER TABLE approvals ADD COLUMN executed_at TEXT;
ALTER TABLE approvals ADD COLUMN execution_evidence_version INTEGER;
ALTER TABLE approvals ADD COLUMN execution_evidence_json TEXT;

-- The approval queue: everything decided but not yet executed, newest last.
-- `idx_approvals_pending` from 0001 indexes undecided rows; a decision is
-- synchronous here, so that index finds nothing and this one is the real queue.
CREATE INDEX idx_approvals_unexecuted ON approvals (decided_at) WHERE executed_at IS NULL;

-- Who granted a standing permission, and why it was taken away. Section 9.1
-- requires grants to be visible and revocable; a revocation with no reason is
-- visible but not answerable.
ALTER TABLE standing_permissions ADD COLUMN granted_by TEXT NOT NULL DEFAULT 'local';
ALTER TABLE standing_permissions ADD COLUMN revoked_reason TEXT;

-- Section 12.1: "A source declares its freshness policy and unavailable
-- semantics." 0001 stored the first and not the second, which left every reader
-- free to decide for itself what an unreachable source meant.
ALTER TABLE sources ADD COLUMN unavailable_semantics TEXT NOT NULL DEFAULT 'unknown';

-- Section 12.2: lineage. An import creates a new row pointing at the external
-- reference it came from, rather than changing that row's kind in place, so
-- "this local file came from that remote thing" survives the import.
ALTER TABLE artifacts ADD COLUMN derived_from_artifact_id TEXT
  REFERENCES artifacts (id) ON DELETE SET NULL;

-- One import per external reference. Two imports of the same remote thing are
-- two local copies that will drift, and the second is almost always a duplicate
-- submit rather than an intention. Unique rather than plain, so it serves the
-- lineage lookup as well and a second index on the column would only be a copy.
CREATE UNIQUE INDEX idx_artifacts_one_import ON artifacts (derived_from_artifact_id)
  WHERE derived_from_artifact_id IS NOT NULL;
