-- Whether a feed's recovery target already owes its turn state: a feed holds one turn at a time,
-- so its turns owe that cleanup once a target, not once a turn. Targets made before this owe it
-- again at their next turn (once).
ALTER TABLE live_recovery_targets ADD COLUMN turn_debt INTEGER NOT NULL DEFAULT 0
  CHECK (turn_debt IN (0, 1));
