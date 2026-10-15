-- Repository transfers, as resumable jobs: the repository's object stops
-- taking changes, the directory moves its owner and name (the old path
-- redirects), the accounts hand over its collaborators and storage, the
-- read model is fenced against the old owner generation, and the object
-- takes its new owner. One row per repository; a finished or failed one is
-- replaced by the next transfer. `transfer_id` names one transfer in every
-- object it changes; `lease_id` lets one runner advance it at a time.
CREATE TABLE repo_transfers (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id),
  transfer_id TEXT NOT NULL,
  from_owner TEXT NOT NULL,
  from_name TEXT NOT NULL,
  to_owner TEXT NOT NULL,
  to_name TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN
    ('freeze', 'directory', 'grants', 'fence', 'repo', 'done', 'cancelling', 'failed')),
  requested_by TEXT,
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX repo_transfers_pending ON repo_transfers (updated_at)
  WHERE step NOT IN ('done', 'failed');
