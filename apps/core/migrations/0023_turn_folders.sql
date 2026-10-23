-- The folder each turn ran in, and the folder each agent session lives in.
-- Claude Code keeps a session under the folder it was started in, so a turn
-- in another folder cannot resume it and starts a fresh one instead.
ALTER TABLE identity_turns ADD COLUMN root_grant_id TEXT;

UPDATE identity_turns
   SET root_grant_id = (
     SELECT json_extract(j.payload_json, '$.primaryRootGrantId')
       FROM node_jobs j
      WHERE j.id = identity_turns.node_job_id
   );

ALTER TABLE identity_sessions ADD COLUMN root_grant_id TEXT;

UPDATE identity_sessions
   SET root_grant_id = COALESCE(
     (SELECT th.root_grant_id FROM identity_threads th WHERE th.id = identity_sessions.thread_id),
     (SELECT t.root_grant_id
        FROM identity_turns t
       WHERE t.thread_id = identity_sessions.thread_id
         AND t.provider_id = identity_sessions.provider_id
         AND t.node_id = identity_sessions.node_id
         AND t.root_grant_id IS NOT NULL
       ORDER BY t.started_at DESC
       LIMIT 1)
   );
