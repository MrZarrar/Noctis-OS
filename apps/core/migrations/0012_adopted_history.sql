-- apps/core/migrations/0012_adopted_history.sql
-- v1, after S8: an adopted thread shows what was said before Noctis.
--
-- The session a thread adopted is where that history lives. Its first turn
-- moves the thread onto a fork, whose transcript also holds Noctis's own
-- turns, so the adopted ref is kept here rather than read back from
-- `identity_sessions`, which by then names the fork.
ALTER TABLE identity_threads ADD COLUMN adopted_session_ref TEXT;
