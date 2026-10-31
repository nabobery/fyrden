-- The read model's restore token, as the directory last knew it: a handshake records its intent
-- (`token_previous`, the token the read model holds, and `token_next`, the one it will), the read
-- model writes the next, and the directory records it as completed (`token_completed`), clearing
-- the intent. A read model holding neither the completed token nor an intent's was restored (or
-- changed) behind the directory's back since the last handshake.
ALTER TABLE read_model_barriers ADD COLUMN token_previous TEXT;
ALTER TABLE read_model_barriers ADD COLUMN token_next TEXT;
ALTER TABLE read_model_barriers ADD COLUMN token_completed TEXT;
