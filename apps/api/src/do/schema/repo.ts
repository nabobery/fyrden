import type { DoMigration } from "@fyrden/adapters-cloudflare/migrations";

/**
 * RepoDO schema. Released migrations never change; add a new version instead.
 * Every released version gets a fixture in test/fixtures/do-schemas/RepoDO/.
 */
export const repoSchema: readonly DoMigration[] = [
  {
    version: 1,
    name: "repo_meta",
    sql: `
      CREATE TABLE repo_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        repo_id TEXT NOT NULL,
        org_id TEXT NOT NULL,
        owner_gen INTEGER NOT NULL DEFAULT 1,
        epoch_gen INTEGER NOT NULL,
        write_frozen INTEGER NOT NULL DEFAULT 0 CHECK (write_frozen IN (0, 1)),
        created_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
];
