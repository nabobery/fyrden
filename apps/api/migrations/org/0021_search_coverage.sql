-- Whether a source's search projections and its full-text entries are known whole
-- (`index_covered`): set by a reconciliation pass that walked the whole source with nothing
-- refused and left no repair asked for, cleared when a pass starts and whenever a repair is asked
-- for (a new revision dirty). It certifies the source alone, not that every source was
-- backfilled.
ALTER TABLE search_sources ADD COLUMN index_covered INTEGER NOT NULL DEFAULT 0
  CHECK (index_covered IN (0, 1));

CREATE INDEX search_sources_uncovered ON search_sources (repo_id) WHERE index_covered = 0;

-- Whether a pass compares the full-text indexes as it walks (`coverage`): only one that does can
-- know its source whole. A pass started before this one left them unlooked at.
ALTER TABLE search_reconciles ADD COLUMN coverage INTEGER NOT NULL DEFAULT 0
  CHECK (coverage IN (0, 1));

CREATE TRIGGER search_repairs_uncover_insert AFTER INSERT ON search_repairs
WHEN NEW.dirty > NEW.covered
BEGIN
  UPDATE search_sources SET index_covered = 0
  WHERE repo_id = NEW.repo_id AND index_covered <> 0;
END;

CREATE TRIGGER search_repairs_uncover_update AFTER UPDATE OF dirty ON search_repairs
WHEN NEW.dirty > OLD.dirty AND NEW.dirty > NEW.covered
BEGIN
  UPDATE search_sources SET index_covered = 0
  WHERE repo_id = NEW.repo_id AND index_covered <> 0;
END;
