-- What reading job logs by the page took of each UTC day (D1's clock) on Free (src/ci/log-reads.ts):
-- R2 Class B operations, charged before a page's first read.
CREATE TABLE ci_log_read_days (
  day INTEGER PRIMARY KEY CHECK (day >= 0),
  class_b INTEGER NOT NULL CHECK (class_b BETWEEN 0 AND 9007199254740991)
) STRICT;
