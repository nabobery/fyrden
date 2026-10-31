-- Sources by their recovery generation: a source hidden since a recovery (its generation older than
-- the read model's) is found through it.
CREATE INDEX search_sources_visible ON search_sources (visible_gen, repo_id);
