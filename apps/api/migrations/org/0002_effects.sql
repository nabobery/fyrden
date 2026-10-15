-- The effects journal: what must happen because of an event (a webhook
-- delivery, a feed update), written in the same batch as the event's
-- projection, keyed by event, sink and target so a redelivered event adds
-- nothing. A dispatcher delivers them after the batch commits; a sweeper
-- retries the ones it could not. Every destination dedupes by effect_id.

CREATE TABLE effects (
  effect_id TEXT PRIMARY KEY,
  sink TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  -- Who is delivering it and until when: a delivery claims the row, and
  -- only the claim's holder records the outcome.
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  done_at INTEGER
) STRICT;

CREATE INDEX effects_due ON effects (next_attempt_at) WHERE state = 'pending';
CREATE INDEX effects_done ON effects (done_at) WHERE state = 'done';
