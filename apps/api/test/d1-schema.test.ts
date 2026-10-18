// The D1 schemas the migrations produce, committed next to the migrations.
// `fyrden doctor` and `fyrden deploy` compare a deployment's databases with
// these files: D1 records a migration as applied by file name only, so a
// database that ran an earlier text of a migration never gets the later one.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Every object the migrations make, tables first, in a stable order. The
// internal tables (SQLite's, Cloudflare's and wrangler's migration log) and
// the indexes SQLite makes itself (no SQL) are not part of the schema.
const SCHEMA = `SELECT type, name, sql FROM sqlite_schema
  WHERE sql IS NOT NULL AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'
    AND name <> 'd1_migrations'
  ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`;

/** Each object as `-- <type> <name>` and its SQL, the format `fyrden doctor` reads. */
async function dumpD1Schema(db: D1Database): Promise<string> {
  const { results } = await db.prepare(SCHEMA).all<{ type: string; name: string; sql: string }>();
  return results.map((row) => `-- ${row.type} ${row.name}\n${row.sql};\n`).join("\n");
}

describe("D1 schemas", () => {
  it("fyrden-directory matches the committed expected schema", async () => {
    await expect(await dumpD1Schema(env.DIRECTORY)).toMatchFileSnapshot(
      "../migrations/directory.expected.sql",
    );
  });

  it("fyrden-org matches the committed expected schema", async () => {
    await expect(await dumpD1Schema(env.ORG_READ)).toMatchFileSnapshot(
      "../migrations/org.expected.sql",
    );
  });
});
