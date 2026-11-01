-- What search's writes and maintenance reads have used of each UTC day's allowance:
-- a step reserves its worst case before it runs and settles to what it used after
-- (a reservation never settled stays spent).
CREATE TABLE search_budget (
  -- Days since the Unix epoch, UTC.
  day INTEGER PRIMARY KEY,
  -- Projection rows written (as D1 counts them).
  rows INTEGER NOT NULL DEFAULT 0,
  -- Rows reconciliations read.
  reads INTEGER NOT NULL DEFAULT 0
) STRICT;

-- The database's size as the latest search batch reported it: `clock` is bumped by
-- every such batch, and an observation is kept only when it comes from a later one
-- than the observation held (so a late report of an earlier batch never lowers it).
CREATE TABLE search_size (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  clock INTEGER NOT NULL,
  observed INTEGER NOT NULL,
  bytes INTEGER NOT NULL
) STRICT;
INSERT INTO search_size (id, clock, observed, bytes) VALUES (1, 0, 0, 0);

-- A pass that ran a step with only removals allowed (the database at its size
-- threshold) covers no repair revision: a whole pass follows.
ALTER TABLE search_reconciles ADD COLUMN partial INTEGER NOT NULL DEFAULT 0
  CHECK (partial IN (0, 1));

-- Where the sweep of covered deletions across sources stands, by table: the key
-- (in the table's deletion index's order) of the last deletion it looked at.
CREATE TABLE search_sweep (
  name TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  deleted_epoch INTEGER NOT NULL,
  deleted_seq INTEGER NOT NULL,
  row INTEGER NOT NULL
) STRICT;
