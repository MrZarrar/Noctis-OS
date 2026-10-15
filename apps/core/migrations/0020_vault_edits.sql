-- apps/core/migrations/0020_vault_edits.sql
-- Every edit the promoter made or proposed, so each can be listed, undone or
-- approved. `before_contents` is the whole note before an applied edit (NULL for
-- a note the edit created); `after_hash` is what undo expects to find.
CREATE TABLE vault_edits (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('fact', 'note', 'revision')),
  path            TEXT NOT NULL,
  source          TEXT NOT NULL,
  text            TEXT NOT NULL,
  replace_text    TEXT,
  status          TEXT NOT NULL CHECK (status IN ('applied', 'undone', 'pending', 'declined', 'refused')),
  reason          TEXT,
  before_contents TEXT,
  after_hash      TEXT,
  turn_id         TEXT,
  created_at      TEXT NOT NULL,
  decided_at      TEXT
);
CREATE INDEX vault_edits_by_time ON vault_edits (created_at);

-- Which inbox notes, at which content, a promoter turn was given.
CREATE TABLE vault_promotions (
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  offered_at   TEXT NOT NULL,
  PRIMARY KEY (path, content_hash, turn_id)
);

-- One row: the thread promoter turns run in.
CREATE TABLE vault_promoter (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  thread_id TEXT NOT NULL
);
