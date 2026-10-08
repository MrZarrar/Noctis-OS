-- apps/core/migrations/0013_archived_threads.sql
-- v1, after S8: the owner tidies the conversation list. An archived named
-- thread leaves the list until restored; nothing about it is deleted.
ALTER TABLE identity_threads ADD COLUMN archived_at TEXT;
