-- Who started a deletion or a transfer, beyond the principal: the agents
-- acting for it (a delegated token's act chain, JSON) and the request, so
-- the repository's own audit row and event name them when the job reaches
-- the repository, however many runs later.
ALTER TABLE repo_deletions ADD COLUMN act_chain TEXT CHECK (act_chain IS NULL OR json_valid(act_chain));
ALTER TABLE repo_deletions ADD COLUMN request_id TEXT;
ALTER TABLE repo_transfers ADD COLUMN request_id TEXT;
