-- apps/core/migrations/0014_passcode.sql
-- A passcode for sensitive Vault notes, ported from the Jarvis donor's Brain
-- PIN lock (server/lib/brain-lock.js, ee7b4527, MIT; DONOR-PORT-LEDGER.md).

-- `sensitive: true` in a note's frontmatter. Derived like every other column
-- here, so a reindex sets it; until then every note reads as not sensitive.
ALTER TABLE vault_items ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;

-- One row or none: the owner's passcode, as a scrypt hash and its salt.
CREATE TABLE passcode (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  salt            TEXT NOT NULL,
  hash            TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  timeout_minutes INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

-- An unlock belongs to the credential that made it: a browser session's id, or
-- `bearer` for the token. No foreign key, because `bearer` is not a session;
-- an unlock outlives nothing it matters for, since it expires in minutes.
CREATE TABLE passcode_unlocks (
  principal  TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
