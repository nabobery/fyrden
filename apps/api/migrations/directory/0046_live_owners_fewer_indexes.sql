-- The table holds at most a deployment's few owners, so a scan costs next to nothing, while each
-- index added written rows to every owner's insert, status change and delete.
DROP INDEX live_duration_owners_class;
DROP INDEX live_duration_owners_object;
