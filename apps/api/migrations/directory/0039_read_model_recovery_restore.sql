-- What a recovery's operator reported of the restore (the bookmark restored to, and the one that
-- undoes it), and what its steps were charged (rows and reads, conservative, never refunded),
-- added to search's recovery spending in the read model when the recovery resumes it.
ALTER TABLE read_model_recoveries ADD COLUMN restore_bookmark TEXT;
ALTER TABLE read_model_recoveries ADD COLUMN undo_bookmark TEXT;
ALTER TABLE read_model_recoveries ADD COLUMN usage_rows INTEGER NOT NULL DEFAULT 0
  CHECK (usage_rows >= 0);
ALTER TABLE read_model_recoveries ADD COLUMN usage_reads INTEGER NOT NULL DEFAULT 0
  CHECK (usage_reads >= 0);
