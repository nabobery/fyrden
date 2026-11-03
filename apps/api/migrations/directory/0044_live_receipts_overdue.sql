-- Expired receipts that call for cleanup (maintenance's own never do), read without walking
-- maintenance's: whether a page is overdue, or one has been for long, is a bounded read.
CREATE INDEX live_budget_receipts_overdue ON live_budget_receipts (expires_at)
  WHERE kind <> 'maintenance';
