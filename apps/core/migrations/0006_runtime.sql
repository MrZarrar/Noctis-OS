-- apps/core/migrations/0006_runtime.sql
-- Intelligence Slice 1: a turn is a record, a model is data, and a thread
-- belongs to an Objective.
--
-- 0001 gave an identity one thread and its messages a `content_ref` that
-- pointed nowhere. Nothing yet said which runtime answered, on which node,
-- with which model, or why. This migration writes those facts down at the
-- moment they are decided, so nothing later has to infer them from logs.

-- Message bodies live apart from the row so content residency can move later
-- (the Vault, a blob store) without rewriting `identity_messages`.
-- `identity_messages.content_ref` points at `message_id` today.
CREATE TABLE identity_message_content (
  message_id TEXT PRIMARY KEY REFERENCES identity_messages (id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One runtime session per thread x provider x node, so a turn resumes where
-- it left off instead of replaying the thread into a fresh process.
CREATE TABLE identity_sessions (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES identity_threads (id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  node_id     TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  session_ref TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (thread_id, provider_id, node_id)
);

-- A turn: one user message in, one reply out, and everything the runtime did
-- in between. `node_job_id` and `node_id` are SET NULL because a turn's record
-- outlives the job and the node that ran it. ADR-0026: `model_json` is the
-- model actually chosen for this turn, written here rather than looked up
-- later against a provider table that may since have changed.
CREATE TABLE identity_turns (
  id               TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL REFERENCES identity_threads (id) ON DELETE CASCADE,
  user_message_id  TEXT NOT NULL REFERENCES identity_messages (id) ON DELETE CASCADE,
  node_job_id      TEXT REFERENCES node_jobs (id) ON DELETE SET NULL,
  node_id          TEXT REFERENCES nodes (id) ON DELETE SET NULL,
  provider_id      TEXT NOT NULL,
  model_json       TEXT NOT NULL,
  status           TEXT NOT NULL,
  items_json       TEXT NOT NULL DEFAULT '[]',
  reply_message_id TEXT REFERENCES identity_messages (id) ON DELETE SET NULL,
  failure_reason   TEXT,
  started_at       TEXT NOT NULL,
  completed_at     TEXT
);

CREATE INDEX idx_identity_turns_thread ON identity_turns (thread_id, started_at);

-- Why this node and this model. Every candidate considered and every reason
-- code, so "why did it pick that" is a read, not a reconstruction.
-- `selected_node_id` is nullable: a decision can be "nothing available".
CREATE TABLE provider_decisions (
  id                   TEXT PRIMARY KEY,
  turn_id              TEXT NOT NULL REFERENCES identity_turns (id) ON DELETE CASCADE,
  requested_model_json TEXT NOT NULL,
  selected_node_id     TEXT,
  selected_model       TEXT,
  candidates_json      TEXT NOT NULL DEFAULT '[]',
  reason_codes_json    TEXT NOT NULL DEFAULT '[]',
  cost_class           TEXT NOT NULL,
  decided_at           TEXT NOT NULL
);

-- An ask raised from inside a runtime turn. `ask_id` is the runtime's own
-- handle for the pending question; the node cannot resume the turn until the
-- core answers under that id, so it must be findable in one lookup. A decline
-- is recorded separately from a refusal: it is the owner saying no, not policy.
ALTER TABLE approvals ADD COLUMN node_job_id TEXT REFERENCES node_jobs (id) ON DELETE SET NULL;
ALTER TABLE approvals ADD COLUMN ask_id TEXT;
ALTER TABLE approvals ADD COLUMN declined_at TEXT;
ALTER TABLE approvals ADD COLUMN declined_by TEXT;

CREATE INDEX idx_approvals_ask ON approvals (ask_id) WHERE ask_id IS NOT NULL;

-- A turn resuming a session must land on the node that holds it. Pinning is a
-- request, not the assignment: `node_id` still records where the job ran.
ALTER TABLE node_jobs ADD COLUMN pinned_node_id TEXT REFERENCES nodes (id) ON DELETE SET NULL;

-- 0.12: one runtime thread per Objective, plus the identity's free-chat thread
-- (objective_id NULL). 0001's "one thread per identity" becomes "one free-chat
-- thread per identity", enforced by the partial unique index.
ALTER TABLE identity_threads ADD COLUMN objective_id TEXT REFERENCES objectives (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_identity_threads_free ON identity_threads (identity_id) WHERE objective_id IS NULL;
CREATE UNIQUE INDEX idx_identity_threads_objective ON identity_threads (identity_id, objective_id) WHERE objective_id IS NOT NULL;

-- ADR-0023: what each node reported it can run, refreshed on every hello.
ALTER TABLE nodes ADD COLUMN providers_json TEXT NOT NULL DEFAULT '[]';
