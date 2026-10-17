-- Repositories a transfer has moved away from an account in the directory
-- that the account has not let go of yet (the `grants` step), by that
-- account: removing a member names them, with the account's own, in what
-- the member's activity feed forgets.
CREATE INDEX repo_transfers_leaving ON repo_transfers (from_owner) WHERE step = 'grants';
