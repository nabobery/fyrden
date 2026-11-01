-- Search's allowances beyond projection rows and reconciliation reads: repository index writes
-- (`repo_rows`: a repository's numbers, membership, counters and index entry, its own allowance
-- of the day), and interactive and recovery work (`interactive_reads`, `recovery_rows`,
-- `recovery_reads`; nothing charges them yet). Byte reservations are released oldest first once
-- an observation of the database's size covers them (`search_byte_reservations_sequence`).
ALTER TABLE search_budget ADD COLUMN repo_rows INTEGER NOT NULL DEFAULT 0
  CHECK (repo_rows >= 0);
ALTER TABLE search_budget ADD COLUMN interactive_reads INTEGER NOT NULL DEFAULT 0
  CHECK (interactive_reads >= 0);
ALTER TABLE search_budget ADD COLUMN recovery_rows INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_rows >= 0);
ALTER TABLE search_budget ADD COLUMN recovery_reads INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_reads >= 0);

CREATE INDEX search_byte_reservations_sequence
  ON search_byte_reservations (sequence, token);
