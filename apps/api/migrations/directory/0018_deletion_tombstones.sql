-- A deleted repository's tombstone (its exported snapshot, JSON) as its
-- deletion put it into the read model: once its object is erased, a
-- rebuild of the read model takes the tombstone from here.
ALTER TABLE repo_deletions ADD COLUMN tombstone TEXT CHECK (tombstone IS NULL OR json_valid(tombstone));
