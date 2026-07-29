-- Locks the create-only hire proposal envelope against UPDATE tampering
-- (plan-delta-005 §7).
--
-- Ten columns are written once at INSERT and describe WHAT was proposed and
-- WHEN it was proposed: the identity, the two authorship columns, the target
-- agent id, the two proposed JSON documents, the validation document, the
-- content hash, and the two timestamps. Nothing in the proposal lifecycle needs
-- to rewrite any of them, so an UPDATE that mentions one is either a repository
-- defect or tampering.
--
-- The five lifecycle columns stay mutable, and 0007/0009 keep governing them:
--   status, decided_at, decided_by, activated_agent_id, activated_version
--
-- A `BEFORE UPDATE OF <cols>` trigger with no WHEN clause fires whenever the
-- SET clause mentions one of those columns, EVEN IF THE VALUE IS UNCHANGED.
-- That is deliberate: a same-value no-op UPDATE on an existing row is refused
-- too, so there is no "write it back identically" path around the guard.
--
-- WHAT THIS MIGRATION DOES NOT DO. It is defense-in-depth against repository
-- and service defects and against after-the-fact UPDATE tampering. It does NOT
-- block an arbitrary same-user DB writer, it does NOT block INSERT forgery, it
-- does NOT block audit_log INSERT forgery, and it does not resolve the open
-- direct-DB-write finding. `INSERT OR REPLACE` is DELETE+INSERT in SQLite and
-- does not fire BEFORE UPDATE triggers at all; the repository is required not
-- to use it on this table, and that requirement is pinned by a static test
-- rather than by this trigger.
--
-- No row, column, index or other trigger is added, dropped or altered, and
-- migrations 0001..0009 stay byte-identical.
CREATE TRIGGER hire_proposals_envelope_immutable
BEFORE UPDATE OF id, requested_by, authored_by, proposed_agent_id,
                 proposed_definition_json, proposed_profile_json, validation_json,
                 proposal_sha256, created_at, expires_at
ON hire_proposals
BEGIN SELECT RAISE(ABORT, 'HIRE_PROPOSAL_ENVELOPE_IMMUTABLE'); END;
