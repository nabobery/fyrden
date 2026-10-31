-- The read model's writers, registered outside it (src/read-model/executor.ts): the barrier
-- a shard's writers are admitted under (its phase and generation, the oldest executor
-- protocol admitted, the executor version verified as serving) and each writer's lease,
-- taken before its work starts and with an absolute deadline every write batch checks. A
-- maintenance pause advances the generation and waits until no lease of an older one is
-- live. `read_model_protocol_since` (the restore floor) is set once enforcement is in.
CREATE TABLE read_model_barriers (
  shard TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  phase TEXT NOT NULL CHECK (phase IN ('running', 'pausing', 'paused', 'recovering')),
  since INTEGER NOT NULL,
  bookmark TEXT,
  protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1),
  executor_version INTEGER NOT NULL DEFAULT 0 CHECK (executor_version >= 0),
  read_model_protocol_since TEXT
) STRICT, WITHOUT ROWID;

INSERT INTO read_model_barriers (shard, generation, phase, since, protocol_version)
VALUES ('default', 1, 'running', CAST(unixepoch('subsec') * 1000 AS INTEGER), 1);

CREATE TABLE read_model_writers (
  lease_id TEXT PRIMARY KEY,
  shard TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  protocol_version INTEGER NOT NULL CHECK (protocol_version >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('ordinary', 'maintenance')),
  until INTEGER NOT NULL CHECK (until > 0)
) STRICT, WITHOUT ROWID;
CREATE INDEX read_model_writers_drain ON read_model_writers (shard, generation, until, lease_id);
