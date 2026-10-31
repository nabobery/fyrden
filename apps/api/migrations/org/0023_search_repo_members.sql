-- The repositories the repository index holds (`indexed = 1`), found without reading every
-- repository's number: a rebuild's look at them, its count and its marks.
CREATE INDEX search_repo_nums_indexed ON search_repo_nums (repo_id) WHERE indexed = 1;
