-- DPoP (RFC 9449): each proof's jti is taken once per key while the proof
-- could be fresh (replays are refused), and an organization may require
-- its agents' API tokens to be DPoP-bound.
CREATE TABLE dpop_proofs (
  jkt TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (jkt, jti)
) STRICT;

CREATE INDEX dpop_proofs_expiry ON dpop_proofs (expires_at);

ALTER TABLE principals ADD COLUMN require_dpop INTEGER NOT NULL DEFAULT 0
  CHECK (require_dpop IN (0, 1));
