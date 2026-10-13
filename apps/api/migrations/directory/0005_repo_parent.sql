-- The repository a fork was made from (null for a repository that is not a
-- fork), for listing a repository's forks and showing a fork's parent.
ALTER TABLE repos ADD COLUMN parent_id TEXT;

-- A caller's forks of one repository, in creation order.
CREATE INDEX repos_forks ON repos (parent_id, owner_id, created_at, id)
  WHERE parent_id IS NOT NULL AND state = 'active';
