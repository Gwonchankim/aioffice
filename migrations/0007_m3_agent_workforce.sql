CREATE TABLE agent_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('builtin','user_created','manager_proposed','imported')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_profile_versions (
  agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version >= 1),
  config_sha256 TEXT NOT NULL,
  config_json TEXT NOT NULL,
  soul_sha256 TEXT NOT NULL,
  harness_sha256 TEXT,
  runtime_selection_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('user_created','manager_proposed','imported')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, version)
);

CREATE TABLE agent_employments (
  agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_definitions(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('draft','active','suspended','retired')),
  active_version INTEGER,
  last_active_version INTEGER,
  activated_at TEXT,
  deactivated_at TEXT,
  actor TEXT NOT NULL,
  reason TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at TEXT NOT NULL,
  CHECK(state <> 'active' OR active_version IS NOT NULL),
  CHECK(state = 'active' OR active_version IS NULL)
);

CREATE TABLE hire_proposals (
  id TEXT PRIMARY KEY NOT NULL,
  requested_by TEXT NOT NULL,
  authored_by TEXT NOT NULL,
  proposed_agent_id TEXT NOT NULL,
  proposed_definition_json TEXT NOT NULL,
  proposed_profile_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  proposal_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_approval','approved','rejected','expired','activated','invalidated')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  activated_agent_id TEXT REFERENCES agent_definitions(id) ON DELETE RESTRICT,
  activated_version INTEGER,
  CHECK(status <> 'pending_approval' OR (decided_at IS NULL AND decided_by IS NULL)),
  CHECK(status = 'pending_approval' OR decided_at IS NOT NULL),
  CHECK(status <> 'expired' OR decided_by IS NULL),
  CHECK(status NOT IN ('approved','rejected','invalidated','activated') OR decided_by IS NOT NULL),
  CHECK(status = 'activated' OR (activated_agent_id IS NULL AND activated_version IS NULL)),
  CHECK(status <> 'activated' OR (activated_agent_id IS NOT NULL AND activated_version IS NOT NULL))
);
CREATE INDEX hire_proposals_status ON hire_proposals(status, expires_at);

-- Seeds run BEFORE the guard triggers are created: the employment seed inserts
-- 17 active rows, which the INSERT guard below deliberately forbids afterwards
-- (same seed-then-trigger pattern as migrations 0004 and 0006).
INSERT INTO agent_definitions (id, name, origin, created_by, created_at) VALUES
  ('atlas', 'Atlas', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('nova', 'Nova', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('miro', 'Miro', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('aegis', 'Aegis', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('ledger', 'Ledger', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('forge', 'Forge', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('luma', 'Luma', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('iris', 'Iris', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('verify', 'Verify', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('sentinel', 'Sentinel', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('archon', 'Archon', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('orion', 'Orion', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('helios', 'Helios', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('regula', 'Regula', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('insight', 'Insight', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('keystone', 'Keystone', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('nexus', 'Nexus', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z'),
  ('arca', 'Arca', 'builtin', 'migration-0007', '2026-07-27T00:00:00.000Z');

-- The v2 full profile rows seeded by 0006 are the initial employment baseline:
-- 17 employed, Arca still `draft` because its registry runtime is out of M3 scope.
INSERT INTO agent_employments (agent_id, state, active_version, last_active_version, activated_at, deactivated_at, actor, reason, revision, updated_at)
SELECT id, 'active', 2, 2, '2026-07-27T00:00:00.000Z', NULL, 'migration-0007', NULL, 1, '2026-07-27T00:00:00.000Z'
FROM agent_definitions WHERE id <> 'arca';
INSERT INTO agent_employments (agent_id, state, active_version, last_active_version, activated_at, deactivated_at, actor, reason, revision, updated_at)
VALUES ('arca', 'draft', NULL, NULL, NULL, NULL, 'migration-0007', 'runtime-not-implemented', 1, '2026-07-27T00:00:00.000Z');

CREATE TRIGGER agent_definitions_append_only_update BEFORE UPDATE ON agent_definitions
BEGIN SELECT RAISE(ABORT, 'AGENT_DEFINITION_APPEND_ONLY'); END;
CREATE TRIGGER agent_definitions_append_only_delete BEFORE DELETE ON agent_definitions
BEGIN SELECT RAISE(ABORT, 'AGENT_DEFINITION_APPEND_ONLY'); END;
CREATE TRIGGER agent_definitions_builtin_seed_only BEFORE INSERT ON agent_definitions
WHEN NEW.origin = 'builtin'
BEGIN SELECT RAISE(ABORT, 'BUILTIN_ORIGIN_SEED_ONLY'); END;

CREATE TRIGGER agent_profile_versions_append_only_update BEFORE UPDATE ON agent_profile_versions
BEGIN SELECT RAISE(ABORT, 'PROFILE_VERSIONS_APPEND_ONLY'); END;
CREATE TRIGGER agent_profile_versions_append_only_delete BEFORE DELETE ON agent_profile_versions
BEGIN SELECT RAISE(ABORT, 'PROFILE_VERSIONS_APPEND_ONLY'); END;

-- Disjoint id spaces keep `(id, version)` unique across both version stores.
CREATE TRIGGER agent_profile_versions_custom_space BEFORE INSERT ON agent_profile_versions
WHEN EXISTS (SELECT 1 FROM agent_definitions WHERE id = NEW.agent_id AND origin = 'builtin')
BEGIN SELECT RAISE(ABORT, 'CUSTOM_VERSION_SPACE_VIOLATION'); END;
CREATE TRIGGER agent_profiles_builtin_space BEFORE INSERT ON agent_profiles
WHEN NOT EXISTS (SELECT 1 FROM agent_definitions WHERE id = NEW.id AND origin = 'builtin')
BEGIN SELECT RAISE(ABORT, 'BUILTIN_PROFILE_SPACE_VIOLATION'); END;

-- New employment rows are always born unemployed; activation must go through
-- the transition path so it cannot skip the lifecycle guard.
CREATE TRIGGER agent_employments_initial_state BEFORE INSERT ON agent_employments
WHEN NEW.state <> 'draft' OR NEW.active_version IS NOT NULL OR NEW.last_active_version IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'AGENT_EMPLOYMENT_INITIAL_STATE'); END;

CREATE TRIGGER agent_employments_transition_guard BEFORE UPDATE OF state ON agent_employments
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'draft' AND NEW.state IN ('active', 'retired')) OR
  (OLD.state = 'active' AND NEW.state IN ('suspended', 'retired')) OR
  (OLD.state = 'suspended' AND NEW.state IN ('active', 'retired')) OR
  (OLD.state = 'retired' AND NEW.state = 'active')
) BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;

-- Arca has no registry runtime in M3, so no path may employ it. The UPDATE
-- path matches this trigger alone, which keeps the raised error deterministic.
CREATE TRIGGER agent_employments_arca_blocked BEFORE UPDATE OF state ON agent_employments
WHEN NEW.agent_id = 'arca' AND NEW.state = 'active'
BEGIN SELECT RAISE(ABORT, 'ARCA_ACTIVATION_BLOCKED'); END;

CREATE TRIGGER agent_employments_append_only_delete BEFORE DELETE ON agent_employments
BEGIN SELECT RAISE(ABORT, 'AGENT_EMPLOYMENT_APPEND_ONLY'); END;

CREATE TRIGGER hire_proposals_transition_guard BEFORE UPDATE OF status ON hire_proposals
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected', 'expired', 'invalidated')) OR
  (OLD.status = 'approved' AND NEW.status IN ('activated', 'expired', 'invalidated'))
) BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;
CREATE TRIGGER hire_proposals_append_only_delete BEFORE DELETE ON hire_proposals
BEGIN SELECT RAISE(ABORT, 'HIRE_PROPOSALS_APPEND_ONLY'); END;

CREATE TABLE migration_0007_verify (id INTEGER PRIMARY KEY);
CREATE TRIGGER migration_0007_verify_guard BEFORE INSERT ON migration_0007_verify
WHEN (
  (SELECT COUNT(*) FROM agent_definitions WHERE origin = 'builtin') <> 18
  OR (SELECT COUNT(*) FROM agent_employments) <> 18
  OR (SELECT COUNT(*) FROM agent_employments WHERE state = 'active' AND active_version = 2) <> 17
  OR (SELECT COUNT(*) FROM agent_employments WHERE agent_id = 'arca' AND state = 'draft' AND active_version IS NULL AND last_active_version IS NULL) <> 1
  OR (SELECT COUNT(*) FROM agent_profiles) <> 36
  OR (SELECT COUNT(*) FROM agent_profile_versions) <> 0
)
BEGIN SELECT RAISE(ABORT, 'M3_WORKFORCE_SEED_MANIFEST_INCOMPLETE'); END;
INSERT INTO migration_0007_verify (id) VALUES (1);
DROP TRIGGER migration_0007_verify_guard;
DROP TABLE migration_0007_verify;
