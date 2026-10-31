-- When an effect is delivered until, for sinks that deliver to a horizon rather than a
-- number of attempts (feed entries: as long as feeds keep them). Past its attempts such an
-- effect keeps being retried at the longest back-off; past this time it ends. NULL: the
-- effect ends after its attempts, as every effect journaled before did.
ALTER TABLE effects ADD COLUMN deliver_until INTEGER;
