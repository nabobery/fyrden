-- What was revoked, written by the revoking statement itself (these
-- triggers), so every path that revokes a credential, a grant or a
-- principal's authority records it in its own transaction (src/live/):
-- `credential:<id>` (a token or a session), `grant:<id>`, and
-- `principal:<id>:<lifecycle generation>` (the generation whose authority
-- ended: an unsuspended principal's later sockets are another
-- generation's). Expiry is not a revocation: every check reads expiry.
-- The sweep finds each one's live sockets through the dependency index
-- (`cursor`: the last socket id it scanned) and delivers to their feeds.
CREATE TABLE revocations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,
  at INTEGER NOT NULL,
  cursor TEXT,
  expanded INTEGER NOT NULL DEFAULT 0 CHECK (expanded IN (0, 1))
) STRICT;
CREATE INDEX revocations_open ON revocations (seq) WHERE expanded = 0;
CREATE INDEX revocations_at ON revocations (at);

CREATE TRIGGER tokens_revoked AFTER UPDATE OF revoked_at ON tokens
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO revocations (subject, at) VALUES ('credential:' || NEW.id, NEW.revoked_at);
END;

CREATE TRIGGER sessions_revoked AFTER UPDATE OF revoked_at ON sessions
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO revocations (subject, at) VALUES ('credential:' || NEW.id, NEW.revoked_at);
END;

CREATE TRIGGER grants_revoked AFTER UPDATE OF revoked_at ON grants
WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
BEGIN
  INSERT INTO revocations (subject, at) VALUES ('grant:' || NEW.id, NEW.revoked_at);
END;

CREATE TRIGGER principals_disabled AFTER UPDATE OF disabled_at ON principals
WHEN OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL
BEGIN
  INSERT INTO revocations (subject, at)
  VALUES ('principal:' || NEW.id || ':' || OLD.lifecycle_gen, NEW.disabled_at);
END;

-- A revocation's feeds still to be told, retried by `next_attempt_at`
-- (earliest first across all revocations, so failing ones fall behind).
CREATE TABLE revocation_targets (
  seq INTEGER NOT NULL,
  feed TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  PRIMARY KEY (seq, feed)
) STRICT, WITHOUT ROWID;
CREATE INDEX revocation_targets_due ON revocation_targets (next_attempt_at, seq, feed);

-- Live sockets, admitted by ticket (`pending` until the feed's object
-- confirms it, then `open`), each for at most its absolute `expires_at`,
-- with the dependencies its credential's authority rests on: what a
-- revocation names finds the feeds holding sockets that rest on it.
CREATE TABLE live_sockets (
  socket_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL UNIQUE,
  feed TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'open')),
  pending_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX live_sockets_expiry ON live_sockets (expires_at);
CREATE INDEX live_sockets_pending ON live_sockets (pending_until) WHERE state = 'pending';
CREATE INDEX live_sockets_credential ON live_sockets (credential_id);
CREATE INDEX live_sockets_feed ON live_sockets (feed);

CREATE TABLE live_socket_deps (
  dependency TEXT NOT NULL,
  socket_id TEXT NOT NULL,
  PRIMARY KEY (dependency, socket_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX live_socket_deps_socket ON live_socket_deps (socket_id);

-- Sockets a principal opened a UTC day (days since the epoch).
CREATE TABLE live_admissions (
  principal_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (principal_id, day)
) STRICT, WITHOUT ROWID;
