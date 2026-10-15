-- Archiving the auth audit log to R2: which rows went into which object,
-- recorded before the object is written, and when each row was archived.
-- Archived rows are deleted after a local retention; unarchived rows never.
-- The directory has no restore generation of its own (its counter would be
-- restored with it); a segment is named by its first row's time and its
-- content's digest, so rows a restore renumbered never take an archived
-- object's name.

ALTER TABLE audit_log ADD COLUMN archived_at INTEGER;

CREATE INDEX audit_log_unarchived ON audit_log (seq) WHERE archived_at IS NULL;
CREATE INDEX audit_log_archived ON audit_log (archived_at) WHERE archived_at IS NOT NULL;

CREATE TABLE audit_segments (
  segment_id INTEGER PRIMARY KEY,
  first_at INTEGER NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER NOT NULL CHECK (to_seq >= from_seq),
  r2_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'archived')),
  created_at INTEGER NOT NULL,
  archived_at INTEGER
) STRICT;

CREATE INDEX audit_segments_archived ON audit_segments (archived_at) WHERE state = 'archived';
CREATE INDEX audit_segments_pending ON audit_segments (from_seq) WHERE state = 'pending';
CREATE INDEX audit_segments_to ON audit_segments (to_seq);
CREATE INDEX audit_segments_from ON audit_segments (from_seq);
