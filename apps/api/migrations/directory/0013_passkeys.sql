-- Human sign-in with passkeys (WebAuthn): each credential's public key (a
-- JWK, with its COSE algorithm) and signature counter, and the single-use
-- challenges a registration or sign-in answers.
CREATE TABLE passkeys (
  -- The credential id, base64url.
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES principals (id),
  public_key TEXT NOT NULL CHECK (json_valid(public_key)),
  alg INTEGER NOT NULL CHECK (alg IN (-7, -8, -257)),
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

CREATE INDEX passkeys_user ON passkeys (user_id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'sign_in')),
  -- The registering user (none for a sign-in, which names its user by the credential).
  user_id TEXT REFERENCES principals (id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges (expires_at);
