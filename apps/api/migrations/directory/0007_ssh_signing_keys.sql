-- SSH keys users sign commits with: a commit with a valid signature by one
-- of a user's keys, whose committer is that user (its no-reply address),
-- is verified. A key belongs to one user (its fingerprint is unique).
CREATE TABLE ssh_signing_keys (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals (id),
  title TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX ssh_signing_keys_fingerprint ON ssh_signing_keys (fingerprint);
CREATE INDEX ssh_signing_keys_principal ON ssh_signing_keys (principal_id, created_at, id);
