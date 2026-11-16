-- Which job a runner may be given is decided from these, in the claim itself: never a fork job
-- (a pull request whose head is in another repository) and never a job of a repository that is
-- public, or not active, when the claim or the re-offer reads it. The defaults fail closed: a row
-- written before this migration matches no repository and counts as a fork job, so it is never
-- offered.
ALTER TABLE ci_pending_jobs ADD COLUMN repo_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ci_pending_jobs ADD COLUMN fork INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ci_tasks ADD COLUMN repo_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ci_tasks ADD COLUMN fork INTEGER NOT NULL DEFAULT 1;
