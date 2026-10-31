-- Sources a recovery found restored but no longer active in the directory (deleted since, or
-- never known): tombstoned in the read model before the writers resume, their search rows purged
-- afterwards a page at a time, at the recovery generation that asked (an older one's are not this
-- one's). Written only through the executor's admission.
CREATE TABLE search_purges (
  repo_id TEXT PRIMARY KEY,
  recovery_gen INTEGER NOT NULL CHECK (recovery_gen >= 1)
) STRICT;

CREATE INDEX search_purges_generation ON search_purges (recovery_gen, repo_id);

CREATE TRIGGER read_model_search_purges_insert BEFORE INSERT ON search_purges
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_purges_update BEFORE UPDATE ON search_purges
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;

CREATE TRIGGER read_model_search_purges_delete BEFORE DELETE ON search_purges
WHEN NOT coalesce((
  SELECT w.open = 1 AND w.lease_id IS NOT NULL AND w.until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND w.protocol_version >= max(b.protocol_version, 2) AND w.generation = b.generation
    AND ((w.mode = 'ordinary' AND b.phase = 'running')
      OR (w.mode = 'maintenance' AND b.phase IN ('pausing', 'paused', 'recovering')))
  FROM read_model_write w JOIN read_model_barrier b ON b.id = 1 WHERE w.id = 1), 0)
BEGIN
  SELECT RAISE(ABORT, 'read_model_admission_required');
END;
