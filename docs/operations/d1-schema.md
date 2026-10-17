# D1 schema drift

wrangler records a D1 migration as applied by its file name only (its
`d1_migrations` table holds an id, the name and the time; verified in
wrangler's source). A database that ran a migration never runs it again, even
if the file changed afterwards, for example when it was deployed from a
working tree with uncommitted changes. That database then lacks what the
later text added, and nothing fails until code uses it.

The schema each database should have is committed beside its migrations, in
`apps/api/migrations/<database>.expected.sql`. Guards:

- CI refuses a pull request that modifies, deletes or renames a migration
  already on its base branch (`tools/ci/src/check-migrations.ts`).
- `fyrden deploy` warns when the working tree has uncommitted changes, records
  the commit on `fyrden-api` as `FYRDEN_COMMIT` (with `-dirty` for such a
  tree), and after applying migrations stops before deploying any Worker if a
  database differs from its expected schema.
- `fyrden doctor` compares each database with its expected schema, names the
  commit `fyrden-api` runs, and summarises the effects journal of
  `fyrden-org` (count and oldest per state; a growing `pending` count is how
  drift in the effects table showed).

## Detecting

```sh
node packages/cli/src/index.ts doctor
```

A drifted database prints a `FAIL` line naming each object that is missing,
differs, or is not in the repository, and doctor exits 1. SQLite stores each
definition as the migration wrote it, so the check compares the tokens SQLite
reads, as written: comments and the spacing between tokens are ignored, but
letter case is not (`DEFAULT Alpha` and `DEFAULT alpha` are different
strings), and spacing that splits a token is not either (`x'41'` is a blob,
`x '41'` the column `x` aliased as `'41'`). The one other difference ignored is
the quoting SQLite adds on a rename: a rebuilt table is stored as
`CREATE TABLE "name" (...)`, and an index created before the rename as
`... ON "name" (...)`, which match `CREATE TABLE name` and `ON name`. To see
the deployed definitions:

```sh
cd apps/api
npx wrangler d1 execute fyrden-org --remote --json \
  --command "SELECT name, sql FROM sqlite_schema WHERE name = 'effects'"
```

## Repairing

Back up first: `npx wrangler d1 export <database> --remote --output backup.sql`.
Never edit `d1_migrations` and never edit a released migration file. Then
either:

- **A forward migration** (preferred): a new numbered file that brings both
  a drifted and a healthy database to one schema. SQLite cannot add a column
  only if it is missing, so rebuild the table: create it under a new name
  with its definition from the expected file (only the name changed), copy
  the columns both versions have, drop the old table (which drops its
  indexes), rename the new one to the old name and recreate its indexes as
  the expected file has them. Update the expected
  file (`pnpm --filter @fyrden/api exec vitest run test/d1-schema.test.ts -u`),
  review the diff, and deploy.
- **A reviewed one-off repair** of that deployment only, when a forward
  migration cannot serve every deployment: write the statements that turn the
  reported objects into their expected definitions, have someone else review
  them against the expected file, and run them with
  `npx wrangler d1 execute <database> --remote --file repair.sql`. A rebuilt
  table keeps its rows only if the statements copy them.

Run `fyrden doctor` again until every database prints `ok`, then deploy.
