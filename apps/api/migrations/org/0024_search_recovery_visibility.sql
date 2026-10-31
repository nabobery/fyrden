-- Which sources search may show after a recovery (`search_index_state.recovery_gen`, raised by
-- each): a source is visible while its row's `visible_gen` is the read model's generation, or it
-- has no row (nothing of it was restored). A whole reconciliation started under the current
-- generation (`search_reconciles.recovery_gen`) sets it; a pass of an older one writes nothing.
ALTER TABLE search_sources ADD COLUMN visible_gen INTEGER NOT NULL DEFAULT 0
  CHECK (visible_gen >= 0);
ALTER TABLE search_reconciles ADD COLUMN recovery_gen INTEGER NOT NULL DEFAULT 0
  CHECK (recovery_gen >= 0);
