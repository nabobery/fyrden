-- The read model's restore token (one row, once a handshake wrote it): the directory's barrier
-- records the one it holds (`read_model_barriers.token_completed`, directory migration 0037), so a
-- read model restored to before the last handshake is told apart. Written only through the
-- executor's admission, as every other table.
CREATE TABLE read_model_restore_token (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL
) STRICT;

CREATE TRIGGER read_model_read_model_restore_token_insert BEFORE INSERT ON read_model_restore_token
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_read_model_restore_token_update BEFORE UPDATE ON read_model_restore_token
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_read_model_restore_token_delete BEFORE DELETE ON read_model_restore_token
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;
