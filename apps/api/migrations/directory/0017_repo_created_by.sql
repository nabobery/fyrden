-- The agent that created a repository acting for its owner (null when the
-- owner created it): each agent's active repositories are limited.
ALTER TABLE repos ADD COLUMN created_by TEXT;
CREATE INDEX repos_created_by ON repos (created_by) WHERE created_by IS NOT NULL AND state = 'active';
