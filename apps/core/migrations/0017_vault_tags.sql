-- apps/core/migrations/0017_vault_tags.sql
-- A note's frontmatter tags, as `|people|family|`, so recall can find the notes
-- a word is a tag of ("my family"). Derived like `sensitive`: a reindex sets it,
-- and until then a note has no tags.
ALTER TABLE vault_items ADD COLUMN tags TEXT NOT NULL DEFAULT '';
