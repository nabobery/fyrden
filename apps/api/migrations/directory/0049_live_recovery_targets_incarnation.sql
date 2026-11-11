-- Recovery targets by incarnation: after a restore, moving a page of those left by another
-- incarnation, and finding none left, each seek the ranges below and above the ledger's own
-- rather than scan every target. Written only when a target is first inserted (a target's later
-- grants never change its incarnation).
CREATE INDEX live_recovery_targets_incarnation ON live_recovery_targets (incarnation, feed);
