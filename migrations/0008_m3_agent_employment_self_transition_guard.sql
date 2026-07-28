-- Rejects employment self-transitions at the database layer (WFM-MIG-001).
--
-- The 0007 guard reads `WHEN NEW.state <> OLD.state AND NOT (<7 allowed pairs>)`.
-- That leading term means a same-state UPDATE never reaches the RAISE, so the
-- four self-transitions (draft->draft, active->active, suspended->suspended,
-- retired->retired) were accepted by the database even though WFM-005 requires
-- all nine rejected ordered pairs to be refused by the trigger and the service
-- both. Dropping the term closes the gap; the allow-list is copied from 0007
-- unchanged, so the seven permitted transitions behave exactly as before.
--
-- Migration 0007 is frozen and stays byte-identical: this is a forward-only
-- replacement of that one trigger, under the same name, and nothing else. No
-- row, seed, employment state, revision or version value is touched, and no
-- other trigger is added, dropped or altered.
--
-- The DROP is deliberately exact rather than `IF EXISTS`. A missing predecessor
-- means the database drifted from 0007, which must surface rather than be
-- absorbed: SQLite raises `no such trigger`, the migration transaction rolls
-- back atomically, and `applyMigrations()` fails closed with MIGRATION_FAILED.
--
-- `active_version` existence stays out of the database on purpose. Its target
-- table depends on the agent's origin, so it cannot be a foreign key, and the
-- approved layer boundary assigns that check to the repository and service
-- layers. Widening this migration with unreviewed column guards is out of scope.
DROP TRIGGER agent_employments_transition_guard;

CREATE TRIGGER agent_employments_transition_guard BEFORE UPDATE OF state ON agent_employments
WHEN NOT (
  (OLD.state = 'draft' AND NEW.state IN ('active', 'retired')) OR
  (OLD.state = 'active' AND NEW.state IN ('suspended', 'retired')) OR
  (OLD.state = 'suspended' AND NEW.state IN ('active', 'retired')) OR
  (OLD.state = 'retired' AND NEW.state = 'active')
) BEGIN SELECT RAISE(ABORT, 'INVALID_STATE_TRANSITION'); END;
