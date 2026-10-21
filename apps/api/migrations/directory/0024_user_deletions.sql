-- Deleting a user (src/accounts/deletion.ts, src/accounts/deletion-runner.ts):
-- a resumable job per user, advanced by its own Durable Object's alarm, its
-- state here, outside everything it removes.
--
-- `user_deletions`: the job. `step` is where it is; `scan_until` the last
-- `source_epochs` rowid of an account recorded before it began (accounts
-- recorded later refuse the user themselves); `account_cursor`,
-- `batch_cursor` and `feed_cursor` where its steps are; `blocked` why it
-- waits (an organization it solely owns); `next_attempt_at` when it may run
-- again; `rearm_after` the recovery cron's rotation; `lease_id` and
-- `lease_until` the run holding it (every checkpoint names its lease);
-- `released_handles` the handles the user and its agents had (JSON
-- `[{ id, handle }]`), which repository deletion and caches still name.
CREATE TABLE user_deletions (
  user_id TEXT PRIMARY KEY REFERENCES principals (id),
  step TEXT NOT NULL
    CHECK (step IN ('repositories', 'accounts', 'stars', 'feeds', 'finalize', 'done')),
  requested_by TEXT,
  request_id TEXT,
  scan_until INTEGER NOT NULL,
  account_cursor INTEGER NOT NULL DEFAULT 0,
  batch_cursor INTEGER NOT NULL DEFAULT 0,
  feed_cursor INTEGER NOT NULL DEFAULT 0,
  blocked TEXT,
  next_attempt_at INTEGER NOT NULL,
  rearm_after INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  released_handles TEXT NOT NULL CHECK (json_valid(released_handles)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
-- The recovery cron's claim: unfinished jobs in rotation order.
CREATE INDEX user_deletions_rearm ON user_deletions (rearm_after, user_id) WHERE step <> 'done';

-- The principals a deletion deletes, fixed when it begins: the user and the
-- agents it owned then, in order (`ord`).
CREATE TABLE user_retirements (
  user_id TEXT NOT NULL REFERENCES user_deletions (user_id),
  principal_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (user_id, principal_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX user_retirements_principal ON user_retirements (principal_id);

-- A user's repositories in any state, for a deletion's last step (the name
-- index leaves deleted ones out).
CREATE INDEX repos_owner ON repos (owner_id, id);
