-- apps/core/migrations/0004_vault.sql
-- Phase 7: the Vault index, its provenance, and its stable layout.
--
-- Section 4.1 lists these six tables; migration 0001 declared the other 25 and
-- deliberately left these for the phase that would fill them.
--
-- Everything here is disposable. Markdown in the configured root is the memory
-- authority (Section 7), so every row below can be dropped and rebuilt by
-- reindexing. Note bodies are never stored — only a hash, so a change can be
-- detected and the derivations it invalidates can be found.

-- Raw observation: one row per indexed Markdown file.
CREATE TABLE vault_items (
  id            TEXT PRIMARY KEY,
  -- Vault-relative, POSIX separators. Unique, because a path is one note.
  path          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  byte_length   INTEGER NOT NULL,
  modified_at   TEXT NOT NULL,
  indexed_at    TEXT NOT NULL
);

CREATE INDEX idx_vault_items_hash ON vault_items (content_hash);

-- Derived: a subject identified by a normalized key. An entity with a NULL
-- item_id is a target that has been linked to but not written yet; it gains an
-- item the moment a note with that key appears, without anything being rewritten.
CREATE TABLE vault_entities (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  item_id    TEXT REFERENCES vault_items (id) ON DELETE SET NULL,
  -- Every key this entity answers to — its title, its filename, and its
  -- Obsidian aliases — as a pipe-delimited, pipe-wrapped string: `|alex-kerr|alex|`.
  -- A wikilink written through an alias has to find the note it names, and
  -- giving each alias its own entity row would put two nodes in the graph for
  -- one note. Normalized keys can never contain a pipe (the wikilink grammar
  -- treats it as the alias separator), so `LIKE '%|alex|%'` cannot false-match.
  keys_index TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_vault_entities_item ON vault_entities (item_id);

CREATE TABLE vault_edges (
  id             TEXT PRIMARY KEY,
  src_entity_id  TEXT NOT NULL REFERENCES vault_entities (id) ON DELETE CASCADE,
  dst_entity_id  TEXT NOT NULL REFERENCES vault_entities (id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  -- The note the relationship was read out of. Every edge has one, which is
  -- what makes an edge navigable back to the prose that claims it.
  source_item_id TEXT NOT NULL REFERENCES vault_items (id) ON DELETE CASCADE,
  confidence     REAL NOT NULL,
  lifecycle      TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (src_entity_id, dst_entity_id, type, source_item_id)
);

CREATE INDEX idx_vault_edges_src ON vault_edges (src_entity_id);
CREATE INDEX idx_vault_edges_dst ON vault_edges (dst_entity_id);

-- Provenance: entity or edge -> the exact span of Markdown that claims it,
-- plus the hash the note had at the time. A mention whose content_hash no
-- longer matches its item is stale, and nothing else is.
CREATE TABLE vault_mentions (
  id           TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL REFERENCES vault_entities (id) ON DELETE CASCADE,
  item_id      TEXT NOT NULL REFERENCES vault_items (id) ON DELETE CASCADE,
  edge_id      TEXT REFERENCES vault_edges (id) ON DELETE CASCADE,
  span_start   INTEGER NOT NULL,
  span_end     INTEGER NOT NULL,
  quote        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_vault_mentions_entity ON vault_mentions (entity_id);
CREATE INDEX idx_vault_mentions_item ON vault_mentions (item_id);

-- Stable, versioned spatial coordinates. One row per entity, updated in place:
-- a note keeps its position across reindexes and restarts, and `version` says
-- which layout algorithm produced it.
CREATE TABLE vault_layout (
  entity_id  TEXT PRIMARY KEY REFERENCES vault_entities (id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  z          REAL NOT NULL,
  settled_at TEXT NOT NULL
);

-- Recall audit: what was asked, what was returned, and how fresh it was.
CREATE TABLE vault_recalls (
  id           TEXT PRIMARY KEY,
  objective_id TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  query        TEXT NOT NULL,
  entity_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_json   TEXT NOT NULL DEFAULT '[]',
  freshness    TEXT NOT NULL,
  recorded_at  TEXT NOT NULL
);

CREATE INDEX idx_vault_recalls_objective ON vault_recalls (objective_id);
