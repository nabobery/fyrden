-- Which incarnation the recovery targets were all last moved to: the ledger's own unless the
-- directory was restored since. Maintenance's five-minute check compares the two on one row,
-- rather than scan every target for one of another incarnation.
ALTER TABLE live_budget_state ADD COLUMN targets_incarnation TEXT NOT NULL DEFAULT ''
  CHECK (length(targets_incarnation) IN (0, 32));

UPDATE live_budget_state SET targets_incarnation = incarnation
WHERE id = 1 AND NOT EXISTS (SELECT 1 FROM live_recovery_targets
  WHERE incarnation <> live_budget_state.incarnation);
