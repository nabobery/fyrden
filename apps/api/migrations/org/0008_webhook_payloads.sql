-- Webhook bodies made from an event's capture: one row per event, which
-- owns the body's object in R2 from before it is stored. An `intent` is
-- written before the object (kept until a day past the event's deadline,
-- so an object stored by a run that then died is found and deleted);
-- `established` once the object is stored, from when its deliveries are
-- made, each kept as long as the body (the deliveries' history);
-- `expired` when a run past the event's deadline found it not established
-- (no run establishes it after, and its object is deleted with it). The
-- webhook cron deletes rows past `expires_at` with their objects, whatever
-- their deliveries; a repository's deletion deletes its rows with its
-- bodies. Deliveries of bodies made from an event's own fields (before
-- captures) have no row: their deliveries own their bodies, as before.

CREATE TABLE webhook_payloads (
  event_key TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  payload_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('intent', 'established', 'expired')),
  -- The stored body's size, once established.
  bytes INTEGER,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX webhook_payloads_expiry ON webhook_payloads (expires_at);
CREATE INDEX webhook_payloads_repo ON webhook_payloads (repo_id);
