-- A source whose search projections need a reconciliation, by revision: `dirty` is
-- the newest revision asked for, `active` the one the pass under way covers (null
-- when none is), `covered` the newest one a finished pass covered. A request with
-- none pending asks for `covered + 1`; one during a pass, `active + 1` (another
-- pass follows); one already pending writes nothing. `next_at` orders the sources
-- the repair job works (oldest first; one that had its turn goes to the back).
CREATE TABLE search_repairs (
  repo_id TEXT PRIMARY KEY,
  dirty INTEGER NOT NULL,
  active INTEGER,
  covered INTEGER NOT NULL DEFAULT 0,
  -- Why the newest revision was asked for, and since when one has been pending.
  reason TEXT NOT NULL,
  since INTEGER NOT NULL,
  next_at INTEGER NOT NULL
) STRICT;
CREATE INDEX search_repairs_due ON search_repairs (next_at, repo_id) WHERE dirty > covered;
