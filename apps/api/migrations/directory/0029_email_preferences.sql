-- Whether notification email goes out, by category (src/email/category.ts):
-- what asks something of the user (`direct`), activity on threads it takes
-- part in or subscribed to (`participating`), activity in repositories it
-- watches (`watching`). A user without a row has the defaults: direct on,
-- the others off.
CREATE TABLE email_preferences (
  principal_id TEXT PRIMARY KEY REFERENCES principals (id),
  direct INTEGER NOT NULL CHECK (direct IN (0, 1)),
  participating INTEGER NOT NULL CHECK (participating IN (0, 1)),
  watching INTEGER NOT NULL CHECK (watching IN (0, 1)),
  updated_at INTEGER NOT NULL
) STRICT;

-- An address generation unsubscribed from one category by an email's link
-- (src/email/unsubscribe.ts): it holds for that address row only, so the
-- address added again starts clean. Rows go with their address.
CREATE TABLE email_unsubscribes (
  email_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('direct', 'participating', 'watching')),
  at INTEGER NOT NULL,
  PRIMARY KEY (email_id, scope)
) STRICT, WITHOUT ROWID;
