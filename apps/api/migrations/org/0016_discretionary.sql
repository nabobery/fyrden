-- Attempts an effect gets at most, when its own (discretionary work: one); NULL: its
-- sink's policy, as before. An effect with it is never retried past it, horizon or not.
ALTER TABLE effects ADD COLUMN max_attempts INTEGER CHECK (max_attempts IS NULL OR max_attempts >= 1);

-- What discretionary work (watched entries) was admitted, by the UTC hour (hours since the
-- Unix epoch) of the database's clock when it was: each admission's price in each resource.
-- A day admits while the hours from one before its start on, with the new price, stay within
-- the allowance; `last_grant` names the effect the hour's row last admitted (the journal
-- inserts an effect only when its admission named it, in the same batch).
CREATE TABLE discretionary_hours (
  hour INTEGER PRIMARY KEY,
  do_requests INTEGER NOT NULL DEFAULT 0,
  do_rows_read INTEGER NOT NULL DEFAULT 0,
  do_rows_written INTEGER NOT NULL DEFAULT 0,
  do_duration_ms INTEGER NOT NULL DEFAULT 0,
  d1_rows_read INTEGER NOT NULL DEFAULT 0,
  d1_rows_written INTEGER NOT NULL DEFAULT 0,
  queue_ops INTEGER NOT NULL DEFAULT 0,
  granted INTEGER NOT NULL DEFAULT 0,
  last_grant TEXT
) STRICT;

-- The latest UTC day (days since the Unix epoch) an admission was refused (no more are
-- admitted that day), and until when feeds report that watched activity may be missing.
CREATE TABLE discretionary_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refused_day INTEGER NOT NULL,
  warn_until INTEGER NOT NULL
) STRICT;
