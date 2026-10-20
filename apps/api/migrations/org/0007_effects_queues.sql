-- Effects are delivered from queues (one per sink): the events consumer
-- publishes the ids it journals, and each sink's consumer claims and
-- delivers them. `next_attempt_at` stays the delivery schedule; these
-- columns add what delivery from a queue needs.

-- Where the effect came from, as the journal admitted it: a claim checks
-- them again (a restore or a transfer since, or the source's deletion,
-- ends the effect instead of delivering it). Null for effects journaled
-- before this migration: those are delivered unchecked, as they were.
ALTER TABLE effects ADD COLUMN source_id TEXT;
ALTER TABLE effects ADD COLUMN epoch_gen INTEGER;
ALTER TABLE effects ADD COLUMN owner_gen INTEGER;
-- The sink's effects stand across a transfer of their source.
ALTER TABLE effects ADD COLUMN any_owner INTEGER NOT NULL DEFAULT 0 CHECK (any_owner IN (0, 1));

-- When a pending effect is overdue unless something moved it on: a short
-- grace after it is journaled (its publication may have been lost), a
-- queue's longest expected wait after a message names it, its claim's end
-- while it is claimed. The effects cron sends a message again for each
-- overdue one and moves this on, so a slow queue costs one message, not a
-- storm. Overdue at once when not said: the Worker deployed before this
-- migration journals effects without it until the new one replaces it,
-- and sends no message for them.
ALTER TABLE effects ADD COLUMN recover_at INTEGER NOT NULL DEFAULT 0;

-- Effects waiting when this ran had no message: overdue once due.
UPDATE effects SET recover_at = next_attempt_at WHERE state = 'pending';

-- The cron's recovery reads overdue effects in this order and stops: only
-- overdue rows are read, however long the backlog. (The health check still
-- reads the oldest pending effect by due time, through effects_due_order:
-- recovery moves recover_at on, so only the due time shows an effect that
-- is never delivered.)
CREATE INDEX IF NOT EXISTS effects_recover ON effects (recover_at, effect_id) WHERE state = 'pending';
