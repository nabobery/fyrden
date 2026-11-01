-- Funded live entries: the duration reserve ordinary owners leave to cleanup set (it was 0, so
-- nothing was held back; 1,000,000 object-ms, Proposed), and the tickets a principal was issued
-- a UTC day (at most 60, counted with the transport that records each, in one batch). A day's row
-- is removed once the day is past, by maintenance.
UPDATE live_budget_state SET duration_reserve_ms = 1000000 WHERE id = 1 AND duration_reserve_ms = 0;

CREATE TABLE live_ticket_days (
  principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
  day INTEGER NOT NULL CHECK (day >= 0),
  issued INTEGER NOT NULL CHECK (issued BETWEEN 1 AND 60),
  PRIMARY KEY (principal_id, day)
) STRICT, WITHOUT ROWID;

CREATE INDEX live_ticket_days_day ON live_ticket_days (day, principal_id);

ALTER TABLE live_ticket_transports ADD COLUMN envelope_json TEXT CHECK (
  envelope_json IS NULL OR (json_valid(envelope_json) AND json_type(envelope_json) = 'object')
);

ALTER TABLE live_sockets ADD COLUMN funding_operation_id TEXT;
