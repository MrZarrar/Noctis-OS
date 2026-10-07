-- apps/core/migrations/0010_delegation.sql
-- v1 S2: one agent hands work to another through Noctis.
--
-- A delegated turn runs on a thread of its own, linked to the thread and turn
-- that asked for it, so the owner can open it and carry on from the phone.
-- A child thread keeps its parent's identity and Objective, which means the
-- 0006 indexes ("one free thread per identity", "one thread per Objective")
-- now hold for top-level threads only.
ALTER TABLE identity_threads ADD COLUMN parent_thread_id TEXT REFERENCES identity_threads (id) ON DELETE CASCADE;
ALTER TABLE identity_threads ADD COLUMN parent_turn_id TEXT REFERENCES identity_turns (id) ON DELETE SET NULL;

DROP INDEX idx_identity_threads_free;
DROP INDEX idx_identity_threads_objective;
CREATE UNIQUE INDEX idx_identity_threads_free ON identity_threads (identity_id)
  WHERE objective_id IS NULL AND parent_thread_id IS NULL;
CREATE UNIQUE INDEX idx_identity_threads_objective ON identity_threads (identity_id, objective_id)
  WHERE objective_id IS NOT NULL AND parent_thread_id IS NULL;
CREATE INDEX idx_identity_threads_parent ON identity_threads (parent_thread_id)
  WHERE parent_thread_id IS NOT NULL;
