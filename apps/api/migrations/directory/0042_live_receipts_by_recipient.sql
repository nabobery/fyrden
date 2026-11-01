-- A feed's unsettled grants found by their recipient and kind: an admission grants the feed a
-- turn, or a block of controls or marks, only when it holds none still valid. The index of turns
-- alone stays while a Worker deployed before this may still use it (removed by a later migration).
CREATE INDEX live_budget_receipts_recipient
  ON live_budget_receipts (recipient, kind, valid_until) WHERE settled_at IS NULL;
