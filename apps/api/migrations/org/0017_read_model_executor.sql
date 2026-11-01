-- Writes to the read model go through one executor (src/read-model/executor.ts): each
-- write batch opens admission as its first statement (checking the barrier's phase and
-- generation, the executor's protocol and its writer lease's deadline, failing the whole
-- batch otherwise) and closes it as its last, in the same transaction. While the rollout
-- runs old and new code side by side, a write made outside an open admission is only
-- counted (`stray`), never refused; a later migration turns these triggers into refusals
-- once no stray writes are seen. `seq` orders the executor's commits.
CREATE TABLE read_model_barrier (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL CHECK (phase IN ('running', 'pausing', 'paused', 'recovering')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1)
) STRICT;

INSERT INTO read_model_barrier (id, phase, generation, protocol_version)
VALUES (1, 'running', 1, 1);

CREATE TABLE read_model_write (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  open INTEGER NOT NULL DEFAULT 0 CHECK (open IN (0, 1)),
  stray INTEGER NOT NULL DEFAULT 0 CHECK (stray >= 0),
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  lease_id TEXT,
  generation INTEGER,
  protocol_version INTEGER,
  until INTEGER,
  mode TEXT CHECK (mode IS NULL OR mode IN ('ordinary', 'maintenance')),
  CHECK (
    open = 0 OR coalesce(
      lease_id IS NOT NULL AND generation >= 1 AND protocol_version >= 1 AND until > 0
        AND mode IS NOT NULL,
      0
    )
  )
) STRICT;

INSERT INTO read_model_write (id, open, stray, seq)
VALUES (1, 0, 0, coalesce((SELECT max(clock, observed) FROM search_size WHERE id = 1), 0));

CREATE TRIGGER read_model_consumer_epochs_insert BEFORE INSERT ON consumer_epochs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_consumer_epochs_update BEFORE UPDATE ON consumer_epochs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_consumer_epochs_delete BEFORE DELETE ON consumer_epochs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_discretionary_hours_insert BEFORE INSERT ON discretionary_hours
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_discretionary_hours_update BEFORE UPDATE ON discretionary_hours
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_discretionary_hours_delete BEFORE DELETE ON discretionary_hours
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_discretionary_state_insert BEFORE INSERT ON discretionary_state
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_discretionary_state_update BEFORE UPDATE ON discretionary_state
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_discretionary_state_delete BEFORE DELETE ON discretionary_state
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_effects_insert BEFORE INSERT ON effects
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_effects_update BEFORE UPDATE ON effects
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_effects_delete BEFORE DELETE ON effects
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_events_failed_insert BEFORE INSERT ON events_failed
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_events_failed_update BEFORE UPDATE ON events_failed
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_events_failed_delete BEFORE DELETE ON events_failed
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_repos_insert BEFORE INSERT ON repos
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_repos_update BEFORE UPDATE ON repos
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_repos_delete BEFORE DELETE ON repos
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_budget_insert BEFORE INSERT ON search_budget
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_budget_update BEFORE UPDATE ON search_budget
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_budget_delete BEFORE DELETE ON search_budget
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_docs_insert BEFORE INSERT ON search_docs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_docs_update BEFORE UPDATE ON search_docs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_docs_delete BEFORE DELETE ON search_docs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_labels_insert BEFORE INSERT ON search_labels
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_labels_update BEFORE UPDATE ON search_labels
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_labels_delete BEFORE DELETE ON search_labels
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_milestones_insert BEFORE INSERT ON search_milestones
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_milestones_update BEFORE UPDATE ON search_milestones
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_milestones_delete BEFORE DELETE ON search_milestones
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_reconciles_insert BEFORE INSERT ON search_reconciles
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_reconciles_update BEFORE UPDATE ON search_reconciles
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_reconciles_delete BEFORE DELETE ON search_reconciles
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_repairs_insert BEFORE INSERT ON search_repairs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_repairs_update BEFORE UPDATE ON search_repairs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_repairs_delete BEFORE DELETE ON search_repairs
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_size_insert BEFORE INSERT ON search_size
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_size_update BEFORE UPDATE ON search_size
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_size_delete BEFORE DELETE ON search_size
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_sources_insert BEFORE INSERT ON search_sources
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_sources_update BEFORE UPDATE ON search_sources
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_sources_delete BEFORE DELETE ON search_sources
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_sweep_insert BEFORE INSERT ON search_sweep
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_sweep_update BEFORE UPDATE ON search_sweep
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_search_sweep_delete BEFORE DELETE ON search_sweep
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_source_owner_insert BEFORE INSERT ON source_owner
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_source_owner_update BEFORE UPDATE ON source_owner
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_source_owner_delete BEFORE DELETE ON source_owner
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_webhook_attempts_insert BEFORE INSERT ON webhook_attempts
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_webhook_attempts_update BEFORE UPDATE ON webhook_attempts
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_webhook_attempts_delete BEFORE DELETE ON webhook_attempts
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_webhook_deliveries_insert BEFORE INSERT ON webhook_deliveries
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_webhook_deliveries_update BEFORE UPDATE ON webhook_deliveries
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_webhook_deliveries_delete BEFORE DELETE ON webhook_deliveries
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_webhook_payloads_insert BEFORE INSERT ON webhook_payloads
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_webhook_payloads_update BEFORE UPDATE ON webhook_payloads
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_webhook_payloads_delete BEFORE DELETE ON webhook_payloads
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_read_model_barrier_insert BEFORE INSERT ON read_model_barrier
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_read_model_barrier_update BEFORE UPDATE ON read_model_barrier
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;

CREATE TRIGGER read_model_read_model_barrier_delete BEFORE DELETE ON read_model_barrier
WHEN coalesce((SELECT open FROM read_model_write WHERE id = 1), 0) <> 1
BEGIN
  UPDATE read_model_write SET stray = stray + 1 WHERE id = 1;
END;
