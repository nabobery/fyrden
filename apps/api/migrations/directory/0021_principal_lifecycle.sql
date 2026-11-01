-- Where a principal stands (src/accounts/lifecycle.ts): active, suspended by
-- an instance administrator, being deleted, or deleted. `lifecycle_gen`
-- counts its transitions: credentials issued after an await are admitted
-- only at the generation their holder was authenticated at, so work begun
-- before a suspension cannot grant authority after it, even once the user is
-- unsuspended. `disabled_at` stays the flag authentication reads: set
-- whenever a user is not active (an agent also has it when disabled, its
-- lifecycle active).
ALTER TABLE principals ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle IN ('active', 'suspended', 'deleting', 'deleted'));
ALTER TABLE principals ADD COLUMN lifecycle_gen INTEGER NOT NULL DEFAULT 0;
-- The last transition's claim: the request that made it (its other statements check it).
ALTER TABLE principals ADD COLUMN lifecycle_claim TEXT;
ALTER TABLE principals ADD COLUMN suspended_at INTEGER;
ALTER TABLE principals ADD COLUMN suspended_by TEXT;
ALTER TABLE principals ADD COLUMN suspended_reason TEXT
  CHECK (suspended_reason IS NULL OR length(suspended_reason) <= 200);

-- A user disabled before lifecycles existed is suspended.
UPDATE principals SET lifecycle = 'suspended', lifecycle_gen = 1, suspended_at = disabled_at
WHERE type = 'user' AND disabled_at IS NOT NULL;

-- The flag and the lifecycle agree: any principal not active is disabled,
-- and a user is disabled only when not active.
CREATE TRIGGER principals_lifecycle_insert BEFORE INSERT ON principals
WHEN (NEW.lifecycle <> 'active' AND NEW.disabled_at IS NULL)
  OR (NEW.type = 'user' AND NEW.lifecycle = 'active' AND NEW.disabled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a principal''s lifecycle and disabled_at disagree');
END;
CREATE TRIGGER principals_lifecycle_update BEFORE UPDATE OF lifecycle, disabled_at ON principals
WHEN (NEW.lifecycle <> 'active' AND NEW.disabled_at IS NULL)
  OR (NEW.type = 'user' AND NEW.lifecycle = 'active' AND NEW.disabled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a principal''s lifecycle and disabled_at disagree');
END;

-- A user's unused authorization requests and codes, which a suspension ends.
CREATE INDEX oauth_requests_unconsumed_user ON oauth_requests (user_id) WHERE used_at IS NULL;

-- Every transition, in its own transaction: what later consumers of a
-- principal's revocation (live updates, email) read, by generation.
CREATE TABLE principal_lifecycle (
  principal_id TEXT NOT NULL REFERENCES principals (id),
  gen INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  at INTEGER NOT NULL,
  actor_id TEXT,
  request_id TEXT,
  PRIMARY KEY (principal_id, gen)
) STRICT, WITHOUT ROWID;
