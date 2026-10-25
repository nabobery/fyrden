-- Settings an operator turns on for the whole deployment (none is on until set):
-- `search_indexing` = 'on' lets search's projections be written and repaired.
CREATE TABLE deployment_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
