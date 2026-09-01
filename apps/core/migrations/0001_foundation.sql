-- apps/core/migrations/0001_foundation.sql
-- Phase 1 foundation schema. All timestamps are UTC ISO 8601 text.
-- All ids are UUIDv7 text. No secrets are stored in this database.

CREATE TABLE objectives (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  intent            TEXT NOT NULL,
  status            TEXT NOT NULL,
  identity_id       TEXT NOT NULL,
  protocol_ids_json TEXT NOT NULL DEFAULT '[]',
  revision          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  activated_at      TEXT,
  completed_at      TEXT
);

CREATE INDEX idx_objectives_active ON objectives (status) WHERE status = 'active';

CREATE TABLE objective_links (
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
  related_type TEXT NOT NULL,
  related_id   TEXT NOT NULL,
  relation     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (objective_id, related_type, related_id, relation)
);

CREATE TABLE missions (
  id            TEXT PRIMARY KEY,
  objective_id  TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  operation_class TEXT NOT NULL,
  host_policy   TEXT NOT NULL,
  host_id       TEXT,
  revision      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT
);

CREATE INDEX idx_missions_objective ON missions (objective_id);
CREATE INDEX idx_missions_status ON missions (status);

CREATE TABLE mission_steps (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  operation_class TEXT NOT NULL,
  status          TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (mission_id, ordinal)
);

CREATE TABLE mission_evidence (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  step_id         TEXT REFERENCES mission_steps (id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  host_id         TEXT NOT NULL,
  summary         TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  observed_at     TEXT NOT NULL
);

CREATE INDEX idx_mission_evidence_mission ON mission_evidence (mission_id);

CREATE TABLE approvals (
  id                  TEXT PRIMARY KEY,
  objective_id        TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  mission_id          TEXT REFERENCES missions (id) ON DELETE SET NULL,
  actor_id            TEXT NOT NULL,
  operation_class     TEXT NOT NULL,
  capability          TEXT NOT NULL,
  target_json         TEXT NOT NULL,
  consequence_summary TEXT NOT NULL,
  reversibility       TEXT NOT NULL,
  estimated_cost_gbp  REAL,
  idempotency_key     TEXT NOT NULL,
  outcome             TEXT,
  policy_id           TEXT,
  reason_codes_json   TEXT NOT NULL DEFAULT '[]',
  permission_id       TEXT REFERENCES standing_permissions (id) ON DELETE SET NULL,
  requested_at        TEXT NOT NULL,
  decided_at          TEXT,
  expires_at          TEXT,
  UNIQUE (idempotency_key)
);

CREATE INDEX idx_approvals_pending ON approvals (outcome) WHERE outcome IS NULL;

CREATE TABLE standing_permissions (
  id               TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL,
  capability       TEXT NOT NULL,
  operation_class  TEXT NOT NULL,
  constraints_json TEXT NOT NULL DEFAULT '{}',
  granted_at       TEXT NOT NULL,
  expires_at       TEXT,
  revoked_at       TEXT
);

CREATE INDEX idx_standing_permissions_active
  ON standing_permissions (actor_id, capability) WHERE revoked_at IS NULL;

CREATE TABLE surface_intents (
  id               TEXT PRIMARY KEY,
  objective_id     TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
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
  requested_at     TEXT NOT NULL
);

CREATE INDEX idx_surface_intents_objective ON surface_intents (objective_id);

CREATE TABLE surface_overrides (
  id                  TEXT PRIMARY KEY,
  surface_id          TEXT NOT NULL REFERENCES surface_intents (id) ON DELETE CASCADE,
  client_id           TEXT NOT NULL,
  display_fingerprint TEXT NOT NULL,
  region              TEXT NOT NULL,
  size                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  released_at         TEXT
);

CREATE TABLE composition_snapshots (
  id                  TEXT PRIMARY KEY,
  objective_id        TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
  layout_id           TEXT NOT NULL,
  display_fingerprint TEXT NOT NULL,
  plan_json           TEXT NOT NULL,
  reason_codes_json   TEXT NOT NULL DEFAULT '[]',
  generated_at        TEXT NOT NULL
);

CREATE TABLE orchestration_events (
  sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  stream_type     TEXT NOT NULL,
  stream_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  actor_type      TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,
  causation_id    TEXT,
  occurred_at     TEXT NOT NULL
);

CREATE INDEX idx_events_stream ON orchestration_events (stream_type, stream_id, sequence);
CREATE INDEX idx_events_correlation ON orchestration_events (correlation_id);

CREATE TABLE identity_threads (
  id                 TEXT PRIMARY KEY,
  identity_id        TEXT NOT NULL,
  active_objective_id TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  revision           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_identity_threads_identity ON identity_threads (identity_id);

CREATE TABLE identity_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES identity_threads (id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  protocol_id TEXT,
  content_ref TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_identity_messages_thread ON identity_messages (thread_id, created_at);

CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,
  host_id       TEXT NOT NULL,
  status        TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  last_seen_at  TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (host_id, fingerprint)
);

CREATE TABLE node_capabilities (
  id                  TEXT PRIMARY KEY,
  node_id             TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  capability          TEXT NOT NULL,
  operation_class     TEXT NOT NULL,
  constraints_version INTEGER NOT NULL,
  constraints_json    TEXT NOT NULL DEFAULT '{}',
  granted_at          TEXT NOT NULL,
  expires_at          TEXT,
  revoked_at          TEXT
);

CREATE INDEX idx_node_capabilities_node ON node_capabilities (node_id) WHERE revoked_at IS NULL;

CREATE TABLE node_jobs (
  id               TEXT PRIMARY KEY,
  mission_id       TEXT REFERENCES missions (id) ON DELETE CASCADE,
  node_id          TEXT REFERENCES nodes (id) ON DELETE SET NULL,
  capability       TEXT NOT NULL,
  status           TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  lease_expires_at TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  payload_version  INTEGER NOT NULL,
  payload_json     TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (idempotency_key)
);

CREATE INDEX idx_node_jobs_lease ON node_jobs (status, lease_expires_at);

CREATE TABLE artifacts (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  uri                TEXT NOT NULL,
  media_type         TEXT,
  objective_id       TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  mission_id         TEXT REFERENCES missions (id) ON DELETE SET NULL,
  source_id          TEXT REFERENCES sources (id) ON DELETE SET NULL,
  host_id            TEXT,
  checksum           TEXT,
  provenance_version INTEGER NOT NULL,
  provenance_json    TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_artifacts_objective ON artifacts (objective_id);

CREATE TABLE sources (
  id                TEXT PRIMARY KEY,
  source_type       TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  freshness_seconds INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (source_type, external_id)
);

CREATE TABLE source_observations (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  expires_at      TEXT
);

CREATE INDEX idx_source_observations_freshness ON source_observations (source_id, observed_at);

CREATE TABLE noir_cases (
  id           TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL,
  synthesis    TEXT,
  revision     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_noir_cases_objective ON noir_cases (objective_id);

CREATE TABLE noir_hypotheses (
  id                   TEXT PRIMARY KEY,
  case_id              TEXT NOT NULL REFERENCES noir_cases (id) ON DELETE CASCADE,
  statement            TEXT NOT NULL,
  rank                 INTEGER NOT NULL,
  status               TEXT NOT NULL,
  confidence_rationale TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_noir_hypotheses_case ON noir_hypotheses (case_id, rank);

CREATE TABLE noir_evidence (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES noir_cases (id) ON DELETE CASCADE,
  hypothesis_id TEXT REFERENCES noir_hypotheses (id) ON DELETE SET NULL,
  source_id     TEXT REFERENCES sources (id) ON DELETE SET NULL,
  artifact_id   TEXT REFERENCES artifacts (id) ON DELETE SET NULL,
  stance        TEXT NOT NULL,
  verification  TEXT NOT NULL,
  summary       TEXT NOT NULL,
  observed_at   TEXT NOT NULL
);

CREATE INDEX idx_noir_evidence_case ON noir_evidence (case_id);

CREATE TABLE noir_falsifiers (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES noir_cases (id) ON DELETE CASCADE,
  hypothesis_id TEXT NOT NULL REFERENCES noir_hypotheses (id) ON DELETE CASCADE,
  check_text    TEXT NOT NULL,
  result        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);

CREATE INDEX idx_noir_falsifiers_case ON noir_falsifiers (case_id);
CREATE INDEX idx_noir_falsifiers_hypothesis ON noir_falsifiers (hypothesis_id);

CREATE TABLE runtime_kv (
  key            TEXT PRIMARY KEY,
  value_version  INTEGER NOT NULL,
  value_json     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key         TEXT NOT NULL,
  scope       TEXT NOT NULL,
  result_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
