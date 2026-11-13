-- Revocations' time-only index, kept by 0048 while a Worker from before it could still run (its
-- reaping named it). Reaping seeks `revocations_reap` now. Apply only once every running Worker
-- is one built with 0048, and no rollback to an older one is planned.
DROP INDEX revocations_at;
