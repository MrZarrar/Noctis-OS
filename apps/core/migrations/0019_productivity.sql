CREATE TABLE reminders (id TEXT PRIMARY KEY, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE notes (id TEXT PRIMARY KEY, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
);
CREATE INDEX idx_task_runs_history ON task_runs(task_id, started_at);
CREATE INDEX idx_task_runs_thread ON task_runs(json_extract(data_json,'$.threadId'));
CREATE UNIQUE INDEX idx_task_runs_active_task ON task_runs(task_id) WHERE status = 'running';
CREATE UNIQUE INDEX idx_task_runs_active_node ON task_runs(node_id) WHERE status = 'running';
CREATE TABLE node_owner_presence (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  present INTEGER NOT NULL CHECK(present IN (0,1)),
  updated_at TEXT NOT NULL
);
ALTER TABLE approvals ADD COLUMN task_id TEXT;
ALTER TABLE standing_permissions ADD COLUMN task_id TEXT;
CREATE INDEX idx_permissions_task ON standing_permissions(task_id);
