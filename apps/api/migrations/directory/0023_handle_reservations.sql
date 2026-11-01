-- Handles a deletion released (src/accounts/handles.ts): no user,
-- organization or agent may take one before `until` (90 days after its
-- release), whatever its case. A later deletion of whoever takes it then
-- replaces the expired row.
CREATE TABLE handle_reservations (
  handle TEXT PRIMARY KEY COLLATE NOCASE,
  principal_id TEXT NOT NULL,
  until INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
