-- Envelopes the events consumer gave up on (the events dead-letter queue): stored before
-- the dead letter is acknowledged, with what they were about. A repository's also ask for
-- its search projections to be reconciled; an account's wait for an operator to replay
-- them; a malformed one is quarantined with why. The envelope itself is kept 14 days
-- (Proposed), the record of the failure after that.
CREATE TABLE events_failed (
  -- The dead letter's message id.
  id TEXT PRIMARY KEY,
  -- The source the envelope came from; null when it could not be read.
  source_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('repository', 'account', 'malformed')),
  -- Its events' positions and types (JSON), when it could be read.
  epoch_gen INTEGER,
  first_seq INTEGER,
  last_seq INTEGER,
  types TEXT CHECK (types IS NULL OR json_valid(types)),
  -- The envelope as it arrived (JSON), until it expires.
  envelope TEXT,
  reason TEXT,
  at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX events_failed_source ON events_failed (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX events_failed_expiry ON events_failed (expires_at) WHERE envelope IS NOT NULL;
