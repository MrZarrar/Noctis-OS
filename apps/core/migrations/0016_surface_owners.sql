CREATE TEMP TABLE overrides_kept AS SELECT * FROM surface_overrides;

CREATE TABLE surface_intents_next (
  id               TEXT PRIMARY KEY,
  objective_id     TEXT REFERENCES objectives (id) ON DELETE CASCADE,
  thread_id        TEXT REFERENCES identity_threads (id) ON DELETE CASCADE,
  presence         INTEGER CHECK (presence = 1),
  kind             TEXT NOT NULL,
  role             TEXT NOT NULL,
  persistence      TEXT NOT NULL,
  lifecycle        TEXT NOT NULL,
  priority         INTEGER NOT NULL,
  min_size         TEXT NOT NULL,
  preferred_region TEXT,
  source_ids_json  TEXT NOT NULL DEFAULT '[]',
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  payload_version  INTEGER NOT NULL,
  payload_json     TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  CHECK ((objective_id IS NOT NULL) + (thread_id IS NOT NULL) + (presence IS NOT NULL) = 1)
);
INSERT INTO surface_intents_next (
  id, objective_id, kind, role,
  persistence, lifecycle, priority, min_size,
  preferred_region, source_ids_json, artifact_ids_json, payload_version,
  payload_json, requested_at
)
SELECT
  id, objective_id, kind, role,
  persistence, lifecycle, priority, min_size,
  preferred_region, source_ids_json, artifact_ids_json, payload_version,
  payload_json, requested_at
FROM surface_intents;
DROP TABLE surface_intents;
ALTER TABLE surface_intents_next RENAME TO surface_intents;

INSERT INTO surface_overrides SELECT * FROM overrides_kept;
DROP TABLE overrides_kept;

CREATE TABLE composition_snapshots_next (
  id                  TEXT PRIMARY KEY,
  objective_id        TEXT REFERENCES objectives (id) ON DELETE CASCADE,
  thread_id        TEXT REFERENCES identity_threads (id) ON DELETE CASCADE,
  presence         INTEGER CHECK (presence = 1),
  layout_id           TEXT NOT NULL,
  display_fingerprint TEXT NOT NULL,
  plan_json           TEXT NOT NULL,
  reason_codes_json   TEXT NOT NULL DEFAULT '[]',
  generated_at        TEXT NOT NULL,
  CHECK ((objective_id IS NOT NULL) + (thread_id IS NOT NULL) + (presence IS NOT NULL) = 1)
);
INSERT INTO composition_snapshots_next (
  id, objective_id, layout_id, display_fingerprint,
  plan_json, reason_codes_json, generated_at
)
SELECT
  id, objective_id, layout_id, display_fingerprint,
  plan_json, reason_codes_json, generated_at
FROM composition_snapshots;
DROP TABLE composition_snapshots;
ALTER TABLE composition_snapshots_next RENAME TO composition_snapshots;

CREATE INDEX idx_surface_intents_objective
  ON surface_intents (objective_id);
CREATE UNIQUE INDEX idx_surface_intents_identity
  ON surface_intents (objective_id, kind, source_ids_json)
  WHERE objective_id IS NOT NULL;
CREATE UNIQUE INDEX idx_composition_snapshots_display
  ON composition_snapshots (objective_id, display_fingerprint)
  WHERE objective_id IS NOT NULL;
CREATE INDEX idx_surface_intents_thread
  ON surface_intents (thread_id);
CREATE UNIQUE INDEX idx_surface_intents_thread_identity
  ON surface_intents (thread_id, kind, source_ids_json)
  WHERE thread_id IS NOT NULL;
CREATE UNIQUE INDEX idx_composition_snapshots_thread_display
  ON composition_snapshots (thread_id, display_fingerprint)
  WHERE thread_id IS NOT NULL;
CREATE INDEX idx_surface_intents_presence
  ON surface_intents (presence);
CREATE UNIQUE INDEX idx_surface_intents_presence_identity
  ON surface_intents (presence, kind, source_ids_json)
  WHERE presence IS NOT NULL;
CREATE UNIQUE INDEX idx_composition_snapshots_presence_display
  ON composition_snapshots (presence, display_fingerprint)
  WHERE presence IS NOT NULL;
