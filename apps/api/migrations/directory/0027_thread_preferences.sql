-- Thread subscriptions: the acknowledged copy of each repository's own
-- record (its `thread_preferences`), one row per principal, repository and
-- conversation (by identity, not number), the latest command by
-- `(epoch_gen, revision)`; a deleted preference stays as `none`, so an
-- older command held in flight cannot bring it back. A restored repository
-- takes its preferences back from here, a kind at a time in
-- `(principal_id, conversation)` order.
CREATE TABLE thread_preferences (
  principal_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  conversation TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull')),
  root_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('subscribed', 'unsubscribed', 'none')),
  revision INTEGER NOT NULL,
  epoch_gen INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, repo_id, conversation)
) STRICT;
CREATE INDEX thread_preferences_repo
  ON thread_preferences (repo_id, kind, principal_id, conversation);
