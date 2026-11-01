-- Search's reconciliation of a source with the repository's own state, and the
-- positions of deletions, so a deletion's row can be collected once a
-- reconciliation's cutoff covers it.

-- Where a deletion is in the source's events (null when unknown: never collected).
ALTER TABLE search_docs ADD COLUMN deleted_epoch INTEGER;
ALTER TABLE search_docs ADD COLUMN deleted_seq INTEGER;
ALTER TABLE search_labels ADD COLUMN deleted_epoch INTEGER;
ALTER TABLE search_labels ADD COLUMN deleted_seq INTEGER;
ALTER TABLE search_milestones ADD COLUMN deleted_epoch INTEGER;
ALTER TABLE search_milestones ADD COLUMN deleted_seq INTEGER;

-- The deletions waiting to be collected.
CREATE INDEX search_docs_deleted ON search_docs (repo_id, deleted_epoch, deleted_seq)
  WHERE deleted = 1 AND deleted_epoch IS NOT NULL;
CREATE INDEX search_labels_deleted ON search_labels (repo_id, deleted_epoch, deleted_seq)
  WHERE deleted = 1 AND deleted_epoch IS NOT NULL;
CREATE INDEX search_milestones_deleted ON search_milestones (repo_id, deleted_epoch, deleted_seq)
  WHERE deleted = 1 AND deleted_epoch IS NOT NULL;

-- A source's reconciliation under way: the export's position (fixed for the
-- pass), its generation (bumped by each pass: a superseded pass's writes are
-- refused) and where it is (the kind and the key it goes on after).
CREATE TABLE search_reconciles (
  repo_id TEXT PRIMARY KEY,
  gen INTEGER NOT NULL CHECK (gen >= 1),
  epoch_gen INTEGER NOT NULL,
  owner_gen INTEGER NOT NULL,
  watermark INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('subjects', 'labels', 'milestones', 'done')),
  after INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL
) STRICT;
