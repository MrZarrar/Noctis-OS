-- apps/core/migrations/0002_nodes.sql
-- Phase 3 node pairing, credentials, and job results.
-- The "no secrets are stored in this database" rule of 0001 still holds:
-- a node credential is derived from the core token and this generation counter,
-- and a pairing code is stored only as a SHA-256 digest of a one-time value.

-- Bumped to invalidate every credential a node currently holds. Verification
-- recomputes the expected value, so nothing here is a secret at rest.
ALTER TABLE nodes ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE node_pairing_codes (
  id         TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL UNIQUE,
  host_id    TEXT NOT NULL,
  issued_at  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Set on redemption. A code with a consumed_at is spent, whatever its expiry.
  consumed_at TEXT,
  node_id    TEXT REFERENCES nodes (id) ON DELETE SET NULL
);

CREATE INDEX idx_node_pairing_codes_open ON node_pairing_codes (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE node_jobs ADD COLUMN result_json TEXT;
ALTER TABLE node_jobs ADD COLUMN failure_reason TEXT;

-- Deliberately no routing_reason column. A queued job's reason code is computed
-- by re-running the router when the job is read, so it is always the current
-- reason; a stored one would be whatever the last dispatch pass thought, and
-- writing it every pass would append to the ledger every few seconds forever.
