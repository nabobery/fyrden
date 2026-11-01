-- The deployment's search indexing generation (the directory's `search_indexing_generation`, raised
-- each time indexing is turned on or off) each reconciliation pass started under, and each source
-- was last known whole under: a source is whole to search only at the current generation, so one
-- certified before indexing last changed is not (what happened while it was off was not projected).
-- Sources known whole by generation, for the status's oldest (uncovered ones apart: there may be
-- many while a backfill runs).
ALTER TABLE search_sources ADD COLUMN indexing_gen INTEGER NOT NULL DEFAULT 0
  CHECK (indexing_gen >= 0);
ALTER TABLE search_reconciles ADD COLUMN indexing_gen INTEGER NOT NULL DEFAULT 0
  CHECK (indexing_gen >= 0);
CREATE INDEX search_sources_indexing ON search_sources (indexing_gen, repo_id)
  WHERE index_covered = 1;
