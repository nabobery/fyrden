-- The token a git token was minted from by its holder (`POST /user/git-tokens`):
-- revoking that token stops this one too, and both share one rate limit.
ALTER TABLE tokens ADD COLUMN source_id TEXT;
