-- Rejects hire proposal self-transitions at the database layer (WFM-MIG-002).
--
-- The 0007 guard reads `WHEN NEW.status <> OLD.status AND NOT (<7 allowed pairs>)`.
-- That leading term means a same-status UPDATE never reaches the RAISE, so the
-- six self-transitions (pending_approval->pending_approval, approved->approved,
-- rejected->rejected, expired->expired, activated->activated,
-- invalidated->invalidated) were accepted by the database. This is the same
-- defect migration 0008 removed from the employment guard, still present on the
-- proposal side: 6 statuses give 36 ordered pairs, of which 7 are allowed and 29
-- must be refused, and all 6 self-transitions belong to the rejected 29.
--
-- Dropping the term closes the gap. The allow-list is copied from 0007
-- character for character, so the seven permitted transitions behave exactly as
-- before and `rejected`, `expired`, `activated` and `invalidated` stay terminal.
--
-- Migrations 0007 and 0008 are frozen and stay byte-identical: this is a
-- forward-only replacement of that one trigger, under the same name, and
-- nothing else. No row, seed, proposal status, definition, profile or
-- employment value is touched, and no other trigger is added, dropped or
-- altered.
--
-- The DROP is deliberately exact rather than `IF EXISTS`. A missing predecessor
-- means the database drifted from 0007, which must surface rather than be
-- absorbed: SQLite raises `no such trigger`, the migration transaction rolls
-- back atomically, and `applyMigrations()` fails closed with MIGRATION_FAILED.
--
-- SQLite runs BEFORE UPDATE triggers ahead of constraint evaluation, so a
-- rejected pair raises INVALID_STATE_TRANSITION and never surfaces a CHECK
-- failure. The 0007 CHECKs still shape what the allowed pairs must write --
-- notably `approved -> expired`, which must clear `decided_by` to satisfy
-- `CHECK(status <> 'expired' OR decided_by IS NULL)` (0007:56).
DROP TRIGGER hire_proposals_transition_guard;

CREATE TRIGGER hire_proposals_transition_guard BEFORE UPDATE OF status ON hire_proposals
WHEN NOT (
  (OLD.status = 'pending_approval' AND NEW.status IN ('approved', 'rejected', 'expired', 'invalidated')) OR
  (OLD.status = 'approved' AND NEW.status IN ('activated', 'expired', 'invalidated'))
) BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;
