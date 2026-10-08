-- apps/core/migrations/0011_threads.sql
-- v1, after S4: many conversations per identity, and sessions started outside Noctis.
--
-- A `named` thread is one the owner opened: a new conversation, or a session an
-- agent already keeps on a PC (VS Code, a terminal) continued here. It may be
-- pinned to where it runs — a node, a shared folder, an agent — so every
-- message on it goes back to the same session. The identity's one free thread
-- stays `free`, and so do Objective and delegated threads; the 0010 index that
-- allows one free thread per identity now counts only those.
ALTER TABLE identity_threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'free' CHECK (kind IN ('free', 'named'));
ALTER TABLE identity_threads ADD COLUMN title TEXT;
ALTER TABLE identity_threads ADD COLUMN node_id TEXT REFERENCES nodes (id) ON DELETE SET NULL;
ALTER TABLE identity_threads ADD COLUMN root_grant_id TEXT;
ALTER TABLE identity_threads ADD COLUMN provider_id TEXT;

DROP INDEX idx_identity_threads_free;
CREATE UNIQUE INDEX idx_identity_threads_free ON identity_threads (identity_id)
  WHERE objective_id IS NULL AND parent_thread_id IS NULL AND kind = 'free';

-- An adopted session is continued in a fork on its first turn, so a session
-- VS Code still has open is never written under. Cleared once a turn returns
-- the fork's own session ref.
ALTER TABLE identity_sessions ADD COLUMN fork_pending INTEGER NOT NULL DEFAULT 0;
