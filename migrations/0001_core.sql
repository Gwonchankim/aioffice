CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL,
  project_key TEXT NOT NULL UNIQUE CHECK(length(project_key) BETWEEN 2 AND 64 AND project_key GLOB '[a-z]*' AND project_key NOT GLOB '*[^a-z0-9_-]*'),
  name TEXT NOT NULL,
  repository_path TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','controlled')),
  provider_policy_json TEXT NOT NULL,
  allowed_agent_ids_json TEXT NOT NULL,
  allowed_commands_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  unregistered_at TEXT
);
CREATE UNIQUE INDEX projects_active_repository_path_unique ON projects(repository_path) WHERE unregistered_at IS NULL;
CREATE TRIGGER projects_project_key_immutable BEFORE UPDATE OF project_key ON projects
WHEN NEW.project_key <> OLD.project_key BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PROJECT_KEY'); END;

CREATE TABLE agent_profiles (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  seed_order INTEGER NOT NULL UNIQUE CHECK(seed_order BETWEEN 1 AND 18),
  config_sha256 TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  execution_mode TEXT NOT NULL CHECK(execution_mode = 'skeleton'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  success_criteria_json TEXT NOT NULL,
  input_artifact_ids_json TEXT NOT NULL,
  max_duration_minutes INTEGER NOT NULL,
  max_agent_runs INTEGER NOT NULL,
  requested_agent_ids_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','planning','queued','running','waiting_approval','succeeded','failed','cancelled','limit_reached')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TRIGGER tasks_project_registered BEFORE INSERT ON tasks
WHEN (SELECT unregistered_at IS NOT NULL FROM projects WHERE id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'PROJECT_UNREGISTERED'); END;
CREATE TRIGGER tasks_transition_guard BEFORE UPDATE OF status ON tasks
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'draft' AND NEW.status IN ('planning','cancelled')) OR
  (OLD.status = 'planning' AND NEW.status IN ('queued','failed','cancelled')) OR
  (OLD.status = 'queued' AND NEW.status IN ('running','cancelled','limit_reached')) OR
  (OLD.status = 'running' AND NEW.status IN ('waiting_approval','succeeded','failed','cancelled','limit_reached')) OR
  (OLD.status = 'waiting_approval' AND NEW.status IN ('queued','cancelled','failed','limit_reached'))
) BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;

CREATE TABLE task_plans (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version >= 1),
  plan_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, version)
);

CREATE TABLE task_steps (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  plan_version INTEGER NOT NULL,
  step_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('waiting','ready','running','retry_wait','waiting_approval','succeeded','failed','skipped','cancelled','interrupted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(task_id, plan_version) REFERENCES task_plans(task_id, version) ON DELETE RESTRICT
);
CREATE TRIGGER task_steps_transition_guard BEFORE UPDATE OF status ON task_steps
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'waiting' AND NEW.status IN ('ready','skipped','cancelled')) OR
  (OLD.status = 'ready' AND NEW.status IN ('running','cancelled','skipped')) OR
  (OLD.status = 'running' AND NEW.status IN ('retry_wait','waiting_approval','succeeded','failed','cancelled','interrupted')) OR
  (OLD.status = 'retry_wait' AND NEW.status IN ('ready','failed','cancelled')) OR
  (OLD.status = 'waiting_approval' AND NEW.status IN ('ready','cancelled','failed')) OR
  (OLD.status = 'interrupted' AND NEW.status IN ('ready','failed','cancelled'))
) BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  step_id TEXT NOT NULL REFERENCES task_steps(id) ON DELETE RESTRICT,
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
  provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic')),
  model TEXT NOT NULL,
  profile_snapshot_json TEXT NOT NULL,
  profile_snapshot_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('starting','running','stalled','succeeded','failed','timed_out','cancelled','interrupted')),
  session_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE UNIQUE INDEX runs_one_running_per_step ON runs(step_id) WHERE status = 'running';
CREATE TRIGGER runs_transition_guard BEFORE UPDATE OF status ON runs
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'starting' AND NEW.status IN ('running','failed','cancelled','interrupted')) OR
  (OLD.status = 'running' AND NEW.status IN ('stalled','succeeded','failed','timed_out','cancelled','interrupted')) OR
  (OLD.status = 'stalled' AND NEW.status IN ('running','succeeded','failed','timed_out','cancelled','interrupted'))
) BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;
CREATE TRIGGER runs_profile_snapshot_immutable BEFORE UPDATE OF profile_snapshot_json, profile_snapshot_sha256 ON runs
WHEN NEW.profile_snapshot_json <> OLD.profile_snapshot_json OR NEW.profile_snapshot_sha256 <> OLD.profile_snapshot_sha256
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_PROFILE_SNAPSHOT'); END;

CREATE TABLE task_event_sequences (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT, next_sequence INTEGER NOT NULL CHECK(next_sequence >= 1));
CREATE TABLE run_event_sequences (run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE RESTRICT, next_sequence INTEGER NOT NULL CHECK(next_sequence >= 1));
CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  step_id TEXT REFERENCES task_steps(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  provider TEXT CHECK(provider IN ('openai','anthropic','system')),
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  task_sequence INTEGER NOT NULL CHECK(task_sequence >= 1),
  run_sequence INTEGER,
  CHECK((run_id IS NULL AND run_sequence IS NULL) OR (run_id IS NOT NULL AND run_sequence IS NOT NULL)),
  UNIQUE(task_id, task_sequence)
);
CREATE UNIQUE INDEX events_run_sequence_unique ON events(run_id, run_sequence) WHERE run_id IS NOT NULL;
CREATE TRIGGER events_append_only_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'EVENTS_APPEND_ONLY'); END;
CREATE TRIGGER events_append_only_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'EVENTS_APPEND_ONLY'); END;

CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  source_id TEXT NOT NULL,
  project_key TEXT NOT NULL REFERENCES projects(project_key) ON DELETE RESTRICT,
  metadata_version INTEGER NOT NULL,
  action_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX approvals_archive_lookup ON approvals(id, status, consumed_at, expires_at);

CREATE TABLE idempotency_records (
  scope_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('in_progress','completed')),
  response_status INTEGER,
  response_body_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(scope_hash, operation, key_hash)
);
CREATE INDEX idempotency_expiry ON idempotency_records(expires_at);

CREATE TABLE provider_policy_confirmations (
  id TEXT PRIMARY KEY NOT NULL,
  session_scope_hash TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('project-create','project-update')),
  project_key TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  policy_hash TEXT NOT NULL,
  warning_statement_version TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK((scope = 'project-create' AND project_key IS NOT NULL AND project_id IS NULL) OR (scope = 'project-update' AND project_key IS NULL AND project_id IS NOT NULL))
);
CREATE INDEX confirmations_active ON provider_policy_confirmations(id, session_scope_hash, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE git_worktrees (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','preserved','released')),
  created_at TEXT NOT NULL
);
CREATE INDEX git_worktrees_project_status ON git_worktrees(project_id, status);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  project_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER audit_log_append_only_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END;
CREATE TRIGGER audit_log_append_only_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END;