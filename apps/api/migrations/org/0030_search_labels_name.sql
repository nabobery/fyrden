-- Live labels by repository and name (ASCII letters folded, as listings compare them): a search's
-- `label:name` resolves to its labels' ids once a scope repository, never by reading a repository's
-- labels for each document it looks at.
CREATE INDEX search_labels_name ON search_labels (repo_id, name COLLATE NOCASE) WHERE deleted = 0;
