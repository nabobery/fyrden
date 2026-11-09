-- Where reaping told revocations has got to in its cycle, and where that cycle ends: each an
-- (at, seq) key of a revocation. Reaping looks at a window of the oldest past their keep after
-- the first and up to the second, moves past a window whose every revocation is still being told,
-- and starts a new cycle (its end the newest past its keep then) once the window runs short, so
-- neither maintenance's check nor its reaping reads more than a window however many wait on their
-- targets, revocations sharing a time are not skipped, and later ones cannot keep a cycle from
-- ending.
ALTER TABLE live_budget_state ADD COLUMN revocations_reap_at INTEGER NOT NULL DEFAULT 0
  CHECK (revocations_reap_at >= 0);
ALTER TABLE live_budget_state ADD COLUMN revocations_reap_seq INTEGER NOT NULL DEFAULT 0
  CHECK (revocations_reap_seq >= 0);
ALTER TABLE live_budget_state ADD COLUMN revocations_reap_end_at INTEGER NOT NULL DEFAULT 0
  CHECK (revocations_reap_end_at >= 0);
ALTER TABLE live_budget_state ADD COLUMN revocations_reap_end_seq INTEGER NOT NULL DEFAULT 0
  CHECK (revocations_reap_end_seq >= 0);

-- Its window sought by the whole key. The time-only index stays while a Worker from before this
-- migration may still run (migrations apply before the deploy, and a rollback runs the old one),
-- since that Worker's reaping names it; a later migration drops it.
CREATE INDEX revocations_reap ON revocations (at, seq);
