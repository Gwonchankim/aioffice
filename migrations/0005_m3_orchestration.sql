CREATE TABLE planning_runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic')),
  model TEXT NOT NULL,
  profile_snapshot_json TEXT NOT NULL,
  profile_snapshot_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  fallback_reason TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK((status = 'running' AND completed_at IS NULL) OR (status <> 'running' AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX planning_runs_one_running_per_task ON planning_runs(task_id) WHERE status = 'running';

CREATE TRIGGER planning_runs_transition_guard BEFORE UPDATE OF status ON planning_runs
WHEN NEW.status <> OLD.status AND NOT (OLD.status = 'running' AND NEW.status IN ('succeeded','failed'))
BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;
CREATE TRIGGER planning_runs_snapshot_immutable BEFORE UPDATE OF profile_snapshot_json, profile_snapshot_sha256 ON planning_runs
WHEN NEW.profile_snapshot_json <> OLD.profile_snapshot_json OR NEW.profile_snapshot_sha256 <> OLD.profile_snapshot_sha256
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PROFILE_SNAPSHOT'); END;
CREATE TRIGGER planning_runs_append_only_delete BEFORE DELETE ON planning_runs
BEGIN SELECT RAISE(ABORT, 'PLANNING_RUNS_APPEND_ONLY'); END;

DROP TRIGGER task_steps_transition_guard;
CREATE TRIGGER task_steps_transition_guard BEFORE UPDATE OF status ON task_steps
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'waiting' AND NEW.status IN ('ready', 'skipped', 'cancelled')) OR
  (OLD.status = 'ready' AND NEW.status IN ('running', 'cancelled', 'skipped')) OR
  (OLD.status = 'running' AND NEW.status IN ('retry_wait', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted')) OR
  (OLD.status = 'retry_wait' AND NEW.status IN ('ready', 'failed', 'cancelled')) OR
  (OLD.status = 'waiting_approval' AND NEW.status IN ('ready', 'cancelled', 'failed')) OR
  (OLD.status = 'interrupted' AND NEW.status IN ('ready', 'failed', 'cancelled')) OR
  (OLD.status = 'failed' AND NEW.status IN ('ready')) -- M3 DEC-015 manual retry
) BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;

DROP TRIGGER tasks_transition_guard;
CREATE TRIGGER tasks_transition_guard BEFORE UPDATE OF status ON tasks
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'draft' AND NEW.status IN ('planning', 'cancelled')) OR
  (OLD.status = 'planning' AND NEW.status IN ('queued', 'failed', 'cancelled')) OR
  (OLD.status = 'queued' AND NEW.status IN ('running', 'cancelled', 'limit_reached')) OR
  (OLD.status = 'running' AND NEW.status IN ('waiting_approval', 'succeeded', 'failed', 'cancelled', 'limit_reached')) OR
  (OLD.status = 'waiting_approval' AND NEW.status IN ('queued', 'cancelled', 'failed', 'limit_reached')) OR
  (OLD.status = 'failed' AND NEW.status IN ('queued')) -- M3 DEC-015 manual retry
) BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;
