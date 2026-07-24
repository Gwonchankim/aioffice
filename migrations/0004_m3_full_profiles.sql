CREATE TABLE agent_profiles_m3 (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  seed_order INTEGER NOT NULL CHECK(seed_order BETWEEN 1 AND 18),
  config_sha256 TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('skeleton','full')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(id, version),
  UNIQUE(version, seed_order)
);

INSERT INTO agent_profiles_m3 (id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at)
SELECT id, version, seed_order, config_sha256, config_json, enabled, execution_mode, created_at FROM agent_profiles;

CREATE TABLE migration_0004_verify (id INTEGER PRIMARY KEY);
CREATE TRIGGER migration_0004_verify_guard BEFORE INSERT ON migration_0004_verify
WHEN (SELECT COUNT(*) FROM agent_profiles_m3 WHERE version = 1 AND enabled = 0 AND execution_mode = 'skeleton') <> 18
BEGIN SELECT RAISE(ABORT, 'PROFILE_REBUILD_ROW_COUNT_MISMATCH'); END;
INSERT INTO migration_0004_verify (id) VALUES (1);
DROP TRIGGER migration_0004_verify_guard;
DROP TABLE migration_0004_verify;

DROP TABLE agent_profiles;
ALTER TABLE agent_profiles_m3 RENAME TO agent_profiles;

CREATE TRIGGER agent_profiles_append_only_update BEFORE UPDATE ON agent_profiles
BEGIN SELECT RAISE(ABORT, 'PROFILE_VERSIONS_APPEND_ONLY'); END;
CREATE TRIGGER agent_profiles_append_only_delete BEFORE DELETE ON agent_profiles
BEGIN SELECT RAISE(ABORT, 'PROFILE_VERSIONS_APPEND_ONLY'); END;
CREATE TRIGGER agent_profiles_seed_conflict BEFORE INSERT ON agent_profiles
WHEN EXISTS (SELECT 1 FROM agent_profiles existing WHERE existing.id = NEW.id AND existing.version = NEW.version AND (existing.config_sha256 <> NEW.config_sha256 OR existing.config_json <> NEW.config_json OR existing.seed_order <> NEW.seed_order OR existing.enabled <> NEW.enabled OR existing.execution_mode <> NEW.execution_mode))
BEGIN SELECT RAISE(ABORT, 'SEED_CONFLICT'); END;
CREATE TRIGGER agent_profiles_seed_order_consistent BEFORE INSERT ON agent_profiles
WHEN EXISTS (SELECT 1 FROM agent_profiles existing WHERE existing.id = NEW.id AND existing.seed_order <> NEW.seed_order)
BEGIN SELECT RAISE(ABORT, 'SEED_ORDER_MISMATCH'); END;
