-- A recovery of a shard's read model (one at a time a shard): its id, the barrier generation it
-- runs at, its stage and where its stage stands (`cursor`), and, once its operational rows are
-- preserved, the sealed manifest of their pages (`manifest`: every page's digest, and the
-- manifest's own). Kept in the directory: the read model is what a restore rolls back.
CREATE TABLE read_model_recoveries (
  shard TEXT PRIMARY KEY,
  recovery_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  stage TEXT NOT NULL CHECK (stage IN ('preserving', 'awaiting_restore', 'importing', 'fencing',
    'resuming', 'complete')),
  cursor TEXT CHECK (cursor IS NULL OR json_valid(cursor)),
  manifest TEXT CHECK (manifest IS NULL OR json_valid(manifest)),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- The pages a recovery preserved of the read model's operational tables, each an object of its
-- own in the assets bucket (`object_key`, its digest in its name) with its digest, rows, bytes
-- and the key of its last row: what an import checks each page against.
CREATE TABLE read_model_preservation_pages (
  recovery_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  page INTEGER NOT NULL CHECK (page >= 0),
  object_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  rows INTEGER NOT NULL CHECK (rows >= 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  last_key TEXT CHECK (last_key IS NULL OR json_valid(last_key)),
  PRIMARY KEY (recovery_id, table_name, page)
) STRICT;
