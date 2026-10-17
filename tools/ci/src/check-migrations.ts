// Fails when a pull request modifies, deletes or renames a D1 migration that
// already exists on its base branch. D1 records a migration as applied by file
// name only, so a database that ran a migration never runs its new text: a
// change must be a new migration. CI runs it on every pull request:
//   node tools/ci/src/check-migrations.ts <base-sha> <head-sha>
// Only the migration files (apps/api/migrations/<database>/...) are frozen;
// the expected schemas beside them (<database>.expected.sql) change with
// every new migration.
import { execFileSync } from "node:child_process";

const MIGRATIONS = "apps/api/migrations/";

export interface ChangedMigration {
  path: string;
  status: "modified" | "deleted";
}

/**
 * The released migrations the pull request changed: everything it did since
 * it left the base branch (`base...head`), so migrations the base branch
 * gained since then are not counted. A rename is a deletion and an addition.
 */
export function changedMigrations(
  base: string,
  head: string,
  cwd = process.cwd(),
): ChangedMigration[] {
  const out = execFileSync(
    "git",
    ["diff", "--name-status", "--no-renames", "-z", `${base}...${head}`, "--", MIGRATIONS],
    { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const fields = out.split("\0").filter((f) => f !== "");
  const changed: ChangedMigration[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] as string;
    const path = fields[i + 1] as string;
    // A file directly in apps/api/migrations/ is an expected schema, not a migration.
    if (status === "A" || !path.slice(MIGRATIONS.length).includes("/")) continue;
    changed.push({ path, status: status === "D" ? "deleted" : "modified" });
  }
  return changed;
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: check-migrations.ts <base> <head>");
    process.exit(2);
  }
  const changed = changedMigrations(base, head);
  for (const c of changed) console.error(`${c.path} was ${c.status}`);
  if (changed.length > 0) {
    console.error(
      "\nA released migration never changes: databases that ran it never run its new text." +
        "\nKeep it as it is on the base branch and add the change as a new numbered migration.",
    );
    process.exit(1);
  }
  console.log("Migrations: no released migration changed.");
}
