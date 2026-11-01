-- When an operator replayed an account's failed envelope (`admin.events.replay`): set when the
-- envelope is claimed to be sent back to the events queue, cleared again if that send fails; null
-- until then. A record is replayed once.
ALTER TABLE events_failed ADD COLUMN requeued_at INTEGER;
