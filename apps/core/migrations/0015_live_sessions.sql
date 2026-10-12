-- apps/core/migrations/0015_live_sessions.sql
-- The live bridge: sessions the owner runs in VS Code or the Codex app,
-- reported by those agents' own hooks. Noctis only reads them; typing into one
-- stays with the agent's own app.

CREATE TABLE live_sessions (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL CHECK (provider_id IN ('claude', 'codex')),
  session_ref TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  title       TEXT,
  status      TEXT NOT NULL CHECK (status IN ('live', 'ended')),
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (node_id, provider_id, session_ref)
);

CREATE INDEX idx_live_sessions_updated ON live_sessions (updated_at);

CREATE TABLE live_session_entries (
  id              TEXT PRIMARY KEY,
  live_session_id TEXT NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'agent')),
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_live_session_entries_session ON live_session_entries (live_session_id, created_at);
