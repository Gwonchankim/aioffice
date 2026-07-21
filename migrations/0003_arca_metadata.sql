CREATE TABLE source_cards (
  source_id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  project_id TEXT NOT NULL REFERENCES projects(project_key) ON DELETE RESTRICT,
  connector_type TEXT NOT NULL CHECK(connector_type IN ('local-folder','registered-git','google-drive','nas')),
  locator TEXT NOT NULL,
  owner TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('public','internal','confidential','controlled')),
  version TEXT NOT NULL,
  checksum_algorithm TEXT NOT NULL CHECK(checksum_algorithm = 'sha256'),
  checksum TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','stale','missing','superseded','archived')),
  supersedes_source_id TEXT REFERENCES source_cards(source_id) ON DELETE RESTRICT,
  metadata_version INTEGER NOT NULL CHECK(metadata_version >= 1)
);
CREATE INDEX source_cards_authorization ON source_cards(project_id, classification, status);
CREATE TABLE source_card_tags (
  source_id TEXT NOT NULL REFERENCES source_cards(source_id) ON DELETE RESTRICT,
  tag TEXT NOT NULL,
  PRIMARY KEY(source_id, tag)
);
CREATE TABLE source_card_roles (
  source_id TEXT NOT NULL REFERENCES source_cards(source_id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  PRIMARY KEY(source_id, role)
);
CREATE TABLE source_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_key) ON DELETE RESTRICT,
  requested_material TEXT NOT NULL,
  criteria TEXT,
  acceptable_formats_json TEXT NOT NULL,
  expected_locations_json TEXT NOT NULL,
  purpose TEXT NOT NULL,
  requester_role TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  resolved_by_source_id TEXT REFERENCES source_cards(source_id) ON DELETE RESTRICT,
  resolved_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('open','resolved','cancelled')),
  metadata_version INTEGER NOT NULL CHECK(metadata_version >= 1),
  CHECK((status = 'resolved' AND resolved_by_source_id IS NOT NULL AND resolved_at IS NOT NULL) OR (status IN ('open','cancelled') AND resolved_by_source_id IS NULL AND resolved_at IS NULL))
);
CREATE INDEX source_requests_project_status ON source_requests(project_id, status);
CREATE TABLE registry_audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  source_id TEXT,
  request_id TEXT,
  project_id TEXT,
  purpose TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('allow','deny')),
  policy_version TEXT NOT NULL,
  connector_type TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER registry_audit_append_only_update BEFORE UPDATE ON registry_audit_log BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END;
CREATE TRIGGER registry_audit_append_only_delete BEFORE DELETE ON registry_audit_log BEGIN SELECT RAISE(ABORT, 'AUDIT_APPEND_ONLY'); END;
CREATE VIRTUAL TABLE source_cards_fts USING fts5(source_id UNINDEXED, title, summary, tags, project_id UNINDEXED, locator, owner, status UNINDEXED);