-- apps/core/migrations/0008_push.sql
-- Slice 2, decision 0.25: the phone hears about an approval nobody has answered
-- and about a turn that failed or was blocked.
--
-- A subscription is a browser's own opaque endpoint plus the two public key
-- material fields the push service requires to encrypt to it. None of it is a
-- Noctis secret. The VAPID private key is, and it lives in the environment --
-- never in this database, never in a log.
--
-- `session_id` is a real foreign key with ON DELETE CASCADE, and the cascade is
-- the cleanup story: `PRAGMA foreign_keys = ON` (db/connection.ts) and
-- `createSession` sweeps expired sessions on the way past, so a phone whose
-- session expired loses its subscription at the same moment it loses its login.
-- A subscription that outlived every session could never be reaped.
CREATE TABLE push_subscriptions (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- Unique because the endpoint *is* the browser's identity here: re-subscribing
  -- the same phone must move the row to the new session, not fan one device out
  -- into a row per login.
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_push_subscriptions_session ON push_subscriptions (session_id);
