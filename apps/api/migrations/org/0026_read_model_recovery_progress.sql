-- Where a recovery's import of the preserved operational rows stands (one row): its recovery, and
-- the table (by its place in the preserved set) and page next to import. Kept in the read model
-- itself, written in the same transaction as the rows it imports, so an import step whose answer
-- was lost is not applied twice. Written only through the executor's admission.
CREATE TABLE read_model_recovery_progress (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  recovery_id TEXT NOT NULL,
  table_index INTEGER NOT NULL CHECK (table_index >= 0),
  page INTEGER NOT NULL CHECK (page >= 0)
) STRICT;

CREATE TRIGGER read_model_read_model_recovery_progress_insert BEFORE INSERT ON read_model_recovery_progress
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_read_model_recovery_progress_update BEFORE UPDATE ON read_model_recovery_progress
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_read_model_recovery_progress_delete BEFORE DELETE ON read_model_recovery_progress
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;
