-- apps/core/migrations/0021_health.sql
-- The latest glycolens report.json the home PC sent (one row), and which job
-- served each weekly Sunday occurrence, so a missed week runs exactly once.
CREATE TABLE health_report (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  state       TEXT NOT NULL CHECK (state IN ('ok', 'unreadable', 'missing')),
  body        TEXT,
  reason      TEXT,
  job_id      TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE health_runs (
  occurrence TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
